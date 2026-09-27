import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Optional, List

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import chromadb
from sentence_transformers import SentenceTransformer

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("rag-pipeline")

# Initialize models and clients
embed_model = None
chroma_client = None
collection = None

# In-memory student name → id map (built at ingest time)
student_name_to_id: dict = {}
student_id_to_name: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    global embed_model, chroma_client, collection
    logger.info("Loading SentenceTransformer model...")
    embed_model = SentenceTransformer('all-MiniLM-L6-v2')

    logger.info("Connecting to ChromaDB at localhost:8000...")
    chroma_client = chromadb.HttpClient(host='localhost', port=8000)

    try:
        collection = chroma_client.get_or_create_collection(name="school_health")
        logger.info(f"ChromaDB collection 'school_health' ready. Count: {collection.count()}")
    except Exception as e:
        logger.error(f"Failed to connect to ChromaDB: {e}")

    yield
    logger.info("Shutting down RAG pipeline...")


app = FastAPI(lifespan=lifespan)


class RetrieveRequest(BaseModel):
    query: str
    role: str
    actorId: str
    targetActorId: Optional[str] = None
    opaConditions: List[str] = []
    allowedStudents: Optional[List[str]] = None


def _norm_name(name: str) -> str:
    """Normalise a student name for lookup."""
    name = (name or '').strip().lower()
    for prefix in ['mr. ', 'ms. ', 'mrs. ', 'mr ', 'ms ', 'mrs ']:
        if name.startswith(prefix):
            name = name[len(prefix):]
    return name.strip()


def get_student_flags(hr: dict) -> List[str]:
    flags = []
    med = hr.get('MedicalFinding', '')
    den = hr.get('DentalFinding', '')
    vis = hr.get('VisionFinding', '')
    if med and 'NAD' not in med:
        flags.append('Medical')
    if den and 'NAD' not in den:
        flags.append('Dental')
    if vis and 'normal' not in vis.lower():
        flags.append('Vision')
    return flags


@app.post("/ingest")
async def ingest_data():
    global student_name_to_id, student_id_to_name

    dataset_path = os.path.join(os.path.dirname(__file__), '..', '..', 'data', 'student_health_dataset.json')
    if not os.path.exists(dataset_path):
        raise HTTPException(status_code=404, detail="Dataset not found")

    with open(dataset_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    students_list = data.get('Students', [])
    health_records = data.get('HealthRecords', [])
    infirmary_records = data.get('InfirmaryRecords', [])

    # Build name ↔ id maps (for infirmary linking)
    student_name_to_id = {}
    student_id_to_name = {}
    students_by_id = {}
    for s in students_list:
        sid = s.get('StudentId', '')
        sname = s.get('StudentName', '')
        student_name_to_id[_norm_name(sname)] = sid
        student_id_to_name[sid] = sname
        students_by_id[sid] = s

    documents = []
    metadatas = []
    ids = []

    logger.info(f"Processing {len(health_records)} health records for ingestion...")

    # ── Health records ─────────────────────────────────────────────────────
    for hr in health_records:
        sid = hr.get('StudentId')
        student = students_by_id.get(sid)
        if not student:
            continue

        name = student.get('StudentName', '')
        cls = student.get('Class', '')
        sec = student.get('Section', '')

        flags = get_student_flags(hr)
        attention_text = "Needs classroom attention due to health flags." if flags else "Healthy, no classroom attention needed."

        text = (
            f"Student Name: {name}\n"
            f"Class: {cls} {sec}\n"
            f"Health Status: {attention_text}\n"
            f"Height: {hr.get('HeightCm')}cm, Weight: {hr.get('WeightKg')}kg\n"
            f"Medical Finding: {hr.get('MedicalFinding')}\n"
            f"Dental Finding: {hr.get('DentalFinding')}\n"
            f"Vision Finding: {hr.get('VisionFinding')}\n"
            f"Respiratory: {hr.get('RespiratorySystem', 'Normal')}\n"
            f"Skin: {hr.get('SkinCondition', 'Normal')}\n"
            f"Recommendation: {hr.get('Recommendation')}\n"
        )

        documents.append(text)
        metadatas.append({
            "student_id": sid,
            "student_name": name,
            "class": str(cls),
            "section": str(sec),
            "has_flags": len(flags) > 0,
            "flag_types": ",".join(flags),
            "type": "health_record"
        })
        ids.append(f"hr_{sid}")

    # ── Infirmary records — group by student, include student_id ──────────
    inf_by_student: dict = {}  # student_id → list of records
    inf_unlinked: dict = {}    # name → list (couldn't find student id)

    for rec in infirmary_records:
        raw_name = rec.get('Student Name', '')
        norm = _norm_name(raw_name)
        sid = student_name_to_id.get(norm)

        # Try partial match if exact fails
        if not sid:
            for stored_norm, stored_sid in student_name_to_id.items():
                if stored_norm and norm and (stored_norm in norm or norm in stored_norm):
                    sid = stored_sid
                    break

        if sid:
            if sid not in inf_by_student:
                inf_by_student[sid] = []
            inf_by_student[sid].append(rec)
        else:
            if norm not in inf_unlinked:
                inf_unlinked[norm] = []
            inf_unlinked[norm].append(rec)

    logger.info(f"Infirmary: {len(inf_by_student)} students linked by StudentId, {len(inf_unlinked)} unlinked")

    for sid, records in inf_by_student.items():
        sname = student_id_to_name.get(sid, 'Unknown')
        student = students_by_id.get(sid, {})
        cls = student.get('Class', '')

        text = f"Infirmary Log for {sname} (StudentId: {sid}):\n"
        for r in records[-10:]:  # last 10 visits
            text += (
                f"- Date: {r.get('Date', 'N/A')}, "
                f"Class: {r.get('Class', cls)}, "
                f"Issue: {r.get('Health Issue', 'N/A')}, "
                f"Action: {r.get('Action Taken', 'N/A')}\n"
            )
            if r.get('Medicine Given'):
                text += f"  Medicine: {r.get('Medicine Given')}\n"
            if r.get('Way Forward / Plan'):
                text += f"  Plan: {r.get('Way Forward / Plan')}\n"

        documents.append(text)
        metadatas.append({
            "student_id": sid,
            "student_name": sname,
            "class": str(cls),
            "type": "infirmary_log",
            "visit_count": len(records)
        })
        ids.append(f"inf_{sid}")

    # Unlinked infirmary records — store by name (less precise access control)
    for norm_name, records in inf_unlinked.items():
        display_name = records[0].get('Student Name', norm_name)
        text = f"Infirmary Log for {display_name} (unlinked):\n"
        for r in records[-5:]:
            text += f"- Date: {r.get('Date', 'N/A')}, Issue: {r.get('Health Issue', 'N/A')}, Action: {r.get('Action Taken', 'N/A')}\n"
        documents.append(text)
        metadatas.append({
            "student_name": display_name,
            "type": "infirmary_log_unlinked"
        })
        ids.append(f"inf_u_{abs(hash(norm_name))}")

    logger.info(f"Generating embeddings for {len(documents)} documents and inserting into ChromaDB...")

    # Batch upsert
    batch_size = 500
    for i in range(0, len(documents), batch_size):
        end = min(i + batch_size, len(documents))
        batch_docs = documents[i:end]
        batch_embs = embed_model.encode(batch_docs).tolist()
        collection.upsert(
            documents=batch_docs,
            embeddings=batch_embs,
            metadatas=metadatas[i:end],
            ids=ids[i:end]
        )
        logger.info(f"Inserted {end}/{len(documents)} records...")

    return {"status": "success", "indexed_count": len(documents)}


@app.post("/retrieve")
async def retrieve_context(req: RetrieveRequest):
    logger.info(f"Retrieval requested: query='{req.query[:60]}' role={req.role} target={req.targetActorId}")

    where_filter = None

    if req.allowedStudents is not None:
        if not req.allowedStudents:
            return {"context": "No students assigned or allowed for your account.", "rawContext": "", "sourcesAvailable": []}

        if req.targetActorId:
            if req.targetActorId in req.allowedStudents:
                where_filter = {"student_name": req.targetActorId}
            else:
                return {
                    "context": f"Access Denied: You do not have relationship permissions to view {req.targetActorId}'s data.",
                    "rawContext": "",
                    "sourcesAvailable": []
                }
        else:
            if len(req.allowedStudents) == 1:
                where_filter = {"student_name": req.allowedStudents[0]}
            else:
                where_filter = {"student_name": {"$in": req.allowedStudents}}
    elif req.targetActorId:
        where_filter = {"student_name": req.targetActorId}

    # Embed query
    query_emb = embed_model.encode([req.query]).tolist()

    try:
        kwargs = {
            "query_embeddings": query_emb,
            "n_results": 10,
        }
        if where_filter:
            kwargs["where"] = where_filter

        results = collection.query(**kwargs)
        context_docs = results['documents'][0] if results['documents'] else []

        # Apply OPA masking
        if "high_level_only" in req.opaConditions or "no_medical_detail" in req.opaConditions:
            masked_docs = []
            for doc in context_docs:
                masked_lines = []
                for line in doc.split("\n"):
                    if any(line.startswith(prefix) for prefix in ["Medical Finding:", "Dental Finding:", "Vision Finding:", "Respiratory:", "Skin:"]):
                        key = line.split(":", 1)[0]
                        masked_lines.append(f"{key}: [REDACTED — High-Level Access Only]")
                    else:
                        masked_lines.append(line)
                masked_docs.append("\n".join(masked_lines))
            context_docs = masked_docs

        context = "\n\n".join(context_docs)
        return {
            "context": context,
            "rawContext": context,
            "sourcesAvailable": results['ids'][0] if results['ids'] else []
        }
    except Exception as e:
        logger.error(f"Retrieval error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
