/**
 * ConvAI — DataQueryService
 *
 * Fast, in-memory structured query layer over student_health_dataset.json.
 * Used as the primary context source for health/attendance/infirmary queries.
 *
 * This eliminates the Python RAG roundtrip for all structured queries,
 * reducing latency from 8-12s to under 200ms.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const documentExtractorService = require('./documentExtractorService');

class DataQueryService {
  constructor() {
    this.data = null;
    this.studentsById = new Map();   // StudentId → student obj
    this.studentsByName = new Map(); // normalised name → student obj
    this.healthById = new Map();     // StudentId → health record
    this.infirmaryByStudentId = new Map(); // StudentId → [visits]
    this.teacherByName = new Map();  // normalised name → teacher obj
    this.parentByName = new Map();   // normalised name → [parent records]
    this.adminByName = new Map();    // normalised name → admin obj
    this.mappingsByStudentId = new Map(); // StudentId → mapping obj
    this.mappingsByTeacherId = new Map(); // TeacherId → [StudentIds]

    this._loading = null;
    this._loaded = false;
    this.datasetPath = path.join(__dirname, '..', '..', 'data', 'student_health_dataset.json');
  }

  /** Normalise a name for case-insensitive lookup */
  _norm(name) {
    return (name || '').toLowerCase().trim()
      .replace(/^(mr\.?|ms\.?|mrs\.?|dr\.?)\s+/i, '');
  }

  /** Levenshtein distance for fuzzy name matching */
  _lev(a, b) {
    if (!a) return b.length;
    if (!b) return a.length;
    const m = Array.from({ length: b.length + 1 }, (_, i) => [i]);
    for (let j = 0; j <= a.length; j++) m[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        m[i][j] = b[i - 1] === a[j - 1]
          ? m[i - 1][j - 1]
          : 1 + Math.min(m[i - 1][j - 1], m[i][j - 1], m[i - 1][j]);
      }
    }
    return m[b.length][a.length];
  }

  /** Load data once, then cache in memory */
  async ensureLoaded() {
    if (this._loaded) return;
    if (this._loading) return this._loading;

    this._loading = (async () => {
      try {
        const raw = await fs.promises.readFile(this.datasetPath, 'utf8');
        this.data = JSON.parse(raw);
        this._buildIndexes();
        this._loaded = true;
        logger.info(`✅ DataQueryService loaded: ${this.studentsById.size} students, ${this.healthById.size} health records`);
      } catch (err) {
        logger.error('DataQueryService: Failed to load dataset', { error: err.message });
        throw err;
      }
      this._loading = null;
    })();
    return this._loading;
  }

  _buildIndexes() {
    this.studentsById.clear();
    this.studentsByName.clear();
    this.healthById.clear();
    this.infirmaryByStudentId.clear();
    this.teacherByName.clear();
    this.parentByName.clear();
    this.adminByName.clear();
    this.mappingsByStudentId.clear();
    this.mappingsByTeacherId.clear();

    // Students
    for (const s of (this.data.Students || [])) {
      this.studentsById.set(s.StudentId, s);
      this.studentsByName.set(this._norm(s.StudentName), s);
    }

    // Health records
    for (const hr of (this.data.HealthRecords || [])) {
      this.healthById.set(hr.StudentId, hr);
    }

    // Infirmary records — link by name to StudentId
    for (const rec of (this.data.InfirmaryRecords || [])) {
      const rawName = rec['Student Name'] || '';
      const normName = this._norm(rawName);
      const student = this.studentsByName.get(normName);
      if (student) {
        if (!this.infirmaryByStudentId.has(student.StudentId)) {
          this.infirmaryByStudentId.set(student.StudentId, []);
        }
        this.infirmaryByStudentId.get(student.StudentId).push(rec);
      }
    }

    // Teachers
    for (const t of (this.data.Teachers || [])) {
      this.teacherByName.set(this._norm(t.TeacherName), t);
    }

    // Parents
    for (const p of (this.data.Parents || [])) {
      const normName = this._norm(p.ParentName);
      if (!this.parentByName.has(normName)) this.parentByName.set(normName, []);
      this.parentByName.get(normName).push(p);
    }

    // Admins
    for (const a of (this.data.Admins || [])) {
      this.adminByName.set(this._norm(a.Name), a);
    }

    // Mappings
    for (const m of (this.data.Mappings || [])) {
      this.mappingsByStudentId.set(m.StudentId, m);
      const tid = m.TeacherId;
      if (tid) {
        if (!this.mappingsByTeacherId.has(tid)) this.mappingsByTeacherId.set(tid, []);
        this.mappingsByTeacherId.get(tid).push(m.StudentId);
      }
    }
  }

  async persistData() {
    try {
      await fs.promises.writeFile(this.datasetPath, JSON.stringify(this.data, null, 2), 'utf8');
      logger.info('✅ student_health_dataset.json updated with newly extracted health records.');
    } catch (err) {
      logger.error('Failed to persist dataset', { error: err.message });
    }
  }

  findStudent(name) {
    const norm = this._norm(name);
    if (this.studentsByName.has(norm)) return this.studentsByName.get(norm);

    for (const [key, student] of this.studentsByName) {
      if (key.includes(norm) || norm.includes(key)) return student;
    }

    const firstName = norm.split(' ')[0];
    if (firstName.length > 2) {
      for (const [key, student] of this.studentsByName) {
        if (key.startsWith(firstName)) return student;
      }
    }

    let bestMatch = null, bestDist = 3;
    for (const [key, student] of this.studentsByName) {
      const dist = this._lev(norm, key);
      if (dist < bestDist) { bestDist = dist; bestMatch = student; }
    }
    return bestMatch;
  }

  /** Get complete health data and trigger dynamic extraction if missing */
  async getStudentFullData(studentId) {
    const student = this.studentsById.get(studentId);
    if (!student) return null;

    let healthRecord = this.healthById.get(studentId) || null;

    // Dynamic Extraction Logic
    if (!healthRecord) {
      logger.info(`No health record found for ${student.StudentName}. Triggering dynamic extraction...`);

      let extracted = null;

      // Prefer extractByRollNo for students from Relationship-2 (files named by roll no)
      if (student.RollNo) {
        extracted = await documentExtractorService.extractByRollNo(
          student.StudentName, student.Class, student.Section, student.RollNo
        );
      }

      // Fall back to fileRef-based extract (for master list students)
      if (!extracted) {
        extracted = await documentExtractorService.extract(
          student.StudentName, student.Class, student.Section
        );
      }

      if (extracted) {
        healthRecord = {
          StudentId: student.StudentId,
          ...extracted
        };
        // Save to in-memory cache
        this.healthById.set(student.StudentId, healthRecord);
        // Save to underlying dataset array
        if (!this.data.HealthRecords) this.data.HealthRecords = [];
        this.data.HealthRecords.push(healthRecord);
        // Persist to JSON asynchronously
        this.persistData();
      }
    }

    const infirmaryLogs = this.infirmaryByStudentId.get(studentId) || [];
    const mapping = this.mappingsByStudentId.get(studentId);

    let assignedTeacher = null;
    if (mapping && mapping.TeacherId) {
      for (const [, t] of this.teacherByName) {
        if (t.TeacherId === mapping.TeacherId) { assignedTeacher = t; break; }
      }
    }

    return { student, healthRecord, infirmaryLogs, assignedTeacher };
  }

  async buildStudentContext(studentId) {
    const data = await this.getStudentFullData(studentId);
    if (!data) return null;

    const { student, healthRecord, infirmaryLogs, assignedTeacher } = data;
    let ctx = `## Student Profile\n`;
    ctx += `- **Name**: ${student.StudentName}\n`;
    ctx += `- **Class & Section**: ${student.Class} ${student.Section || ''}\n`;
    ctx += `- **Roll No**: ${student.RollNo || 'N/A'}\n`;
    ctx += `- **Gender**: ${student.Gender || 'N/A'}\n`;
    ctx += `- **DOB**: ${student.DOB || 'N/A'}\n`;
    
    if (assignedTeacher) {
      const studentIds = this.mappingsByTeacherId.get(assignedTeacher.TeacherId) || [];
      ctx += `- **Assigned Class Teacher**: ${assignedTeacher.TeacherName}\n`;
      ctx += `- **Total Students in Class**: ${studentIds.length}\n`;
    }
    ctx += `\n`;

    if (healthRecord) {
      const bmi = healthRecord.BMI || (healthRecord.HeightCm && healthRecord.WeightKg
        ? (parseFloat(healthRecord.WeightKg) / Math.pow(parseFloat(healthRecord.HeightCm) / 100, 2)).toFixed(1)
        : 'N/A');

      ctx += `**Health Record**\n`;
      ctx += `- **Height**: ${healthRecord.HeightCm || 'N/A'} cm\n`;
      ctx += `- **Weight**: ${healthRecord.WeightKg || 'N/A'} kg\n`;
      ctx += `- **BMI**: ${bmi}\n`;
      ctx += `- **Medical Finding**: ${healthRecord.MedicalFinding || 'NAD (Nothing Abnormal Detected)'}\n`;
      ctx += `- **Dental Finding**: ${healthRecord.DentalFinding || 'NAD'}\n`;
      ctx += `- **Vision**: ${healthRecord.VisionFinding || 'Normal'}\n`;
      ctx += `- **Respiratory System**: ${healthRecord.RespiratorySystem || 'Normal'}\n`;
      ctx += `- **Skin Condition**: ${healthRecord.SkinCondition || 'Normal'}\n`;
      if (healthRecord.NervousSystem) ctx += `- **Nervous System**: ${healthRecord.NervousSystem}\n`;
      if (healthRecord.CVS) ctx += `- **Cardiovascular (CVS)**: ${healthRecord.CVS}\n`;
      if (healthRecord.Abdomen) ctx += `- **Per Abdomen**: ${healthRecord.Abdomen}\n`;
      ctx += `- **Doctor's Recommendation**: ${healthRecord.Recommendation || 'None'}\n\n`;
    } else {
      ctx += `**Health Record**\n- No formal health record available in the system.\n\n`;
    }

    if (infirmaryLogs.length > 0) {
      ctx += `**Infirmary Visit Logs (${infirmaryLogs.length} total, showing last ${Math.min(infirmaryLogs.length, 5)})**\n`;
      const sorted = [...infirmaryLogs].sort((a, b) => (b.Date || '').localeCompare(a.Date || ''));
      for (const log of sorted.slice(0, 5)) {
        ctx += `- **Date**: ${log.Date || 'N/A'} | **Issue**: ${log['Health Issue'] || 'N/A'}\n`;
        ctx += `  **Action Taken**: ${log['Action Taken'] || 'N/A'}\n`;
        if (log['Medicine Given']) ctx += `  **Medicine Given**: ${log['Medicine Given']}\n`;
        if (log['Way Forward / Plan']) ctx += `  **Plan**: ${log['Way Forward / Plan']}\n`;
      }
      ctx += '\n';
    } else {
      ctx += `**Infirmary Visit Logs**\n- No infirmary visits recorded.\n\n`;
    }

    return ctx;
  }

  async buildTeacherClassroomContext(teacherName) {
    const teacher = this.teacherByName.get(this._norm(teacherName));
    if (!teacher) return null;

    const studentIds = this.mappingsByTeacherId.get(teacher.TeacherId) || [];
    if (studentIds.length === 0) return null;

    let ctx = `**Classroom Health Summary for ${teacher.TeacherName}**\n`;
    ctx += `- **Assigned Class**: ${teacher.AssignedClass} ${teacher.Section}\n`;
    ctx += `- **Total Students Assigned**: ${studentIds.length}\n\n`;

    let flaggedCount = 0;
    const rows = [];

    // Important: run these sequentially or with Promise.all to handle dynamic extractions correctly
    for (const sid of studentIds) {
      const student = this.studentsById.get(sid);
      if (!student) continue;

      // This ensures we extract dynamically if needed for classroom summaries too
      const fullData = await this.getStudentFullData(sid);
      const hr = fullData ? fullData.healthRecord : null;
      const infVisits = (this.infirmaryByStudentId.get(sid) || []).length;
      const flags = [];

      if (hr) {
        if (hr.MedicalFinding && !hr.MedicalFinding.includes('NAD')) flags.push('Medical');
        if (hr.DentalFinding && !hr.DentalFinding.includes('NAD')) flags.push('Dental');
        if (hr.VisionFinding && !hr.VisionFinding.toLowerCase().includes('normal')) flags.push('Vision');
      }
      if (infVisits > 2) flags.push(`Frequent Infirmary (${infVisits} visits)`);

      if (flags.length > 0) flaggedCount++;

      rows.push({
        name: student.StudentName,
        rollNo: student.RollNo || 'N/A',
        flags,
        infVisits,
        recommendation: hr ? (hr.Recommendation || 'None') : 'No record',
      });
    }

    rows.sort((a, b) => b.flags.length - a.flags.length);

    ctx += `**⚠️ Students Needing Attention (${flaggedCount} of ${studentIds.length})**\n`;
    for (const row of rows) {
      const needsAttention = row.flags.length > 0;
      ctx += `\n**${row.name}** (Roll: ${row.rollNo})\n`;
      ctx += `  - Status: ${needsAttention ? '⚠️ Needs Attention' : '✅ Healthy'}\n`;
      if (row.flags.length > 0) ctx += `  - Flags: ${row.flags.join(', ')}\n`;
      if (row.infVisits > 0) ctx += `  - Infirmary Visits: ${row.infVisits}\n`;
      if (row.recommendation && row.recommendation !== 'None' && row.recommendation !== 'No record') {
        ctx += `  - Recommendation: ${row.recommendation}\n`;
      }
    }

    return ctx;
  }

  async buildParentSingleChildContext(studentId) {
    const childCtx = await this.buildStudentContext(studentId);
    if (!childCtx) return null;
    return `## Your Child's Health Information\n\n${childCtx}`;
  }

  async buildParentChildrenContext(parentName, allowedStudentIds = null) {
    const normName = this._norm(parentName);
    const parentRecords = this.parentByName.get(normName) || [];

    if (parentRecords.length === 0) return null;

    const childIds = parentRecords.map(p => p.StudentId);
    const finalIds = allowedStudentIds
      ? childIds.filter(id => allowedStudentIds.includes(id))
      : childIds;

    if (finalIds.length === 0) return null;

    let ctx = `## Your Child(ren)'s Health Information\n\n`;
    for (const sid of finalIds) {
      const childCtx = await this.buildStudentContext(sid);
      if (childCtx) ctx += childCtx + '\n---\n\n';
    }
    return ctx;
  }

  buildAdminSchoolStats() {
    const totalStudents = this.studentsById.size;
    const totalWithHealthRecords = this.healthById.size;
    const totalWithInfirmaryLogs = this.infirmaryByStudentId.size;

    let medicalFlags = 0, dentalFlags = 0, visionFlags = 0;
    for (const hr of this.healthById.values()) {
      if (hr.MedicalFinding && !hr.MedicalFinding.includes('NAD')) medicalFlags++;
      if (hr.DentalFinding && !hr.DentalFinding.includes('NAD')) dentalFlags++;
      if (hr.VisionFinding && !hr.VisionFinding.toLowerCase().includes('normal')) visionFlags++;
    }

    let totalInfVisits = 0;
    for (const logs of this.infirmaryByStudentId.values()) totalInfVisits += logs.length;

    let ctx = `**School-Wide Health Statistics**\n`;
    ctx += `- **Total Students**: ${totalStudents}\n`;
    const pct = totalStudents > 0 ? Math.round((totalWithHealthRecords * 100) / totalStudents) : 0;
    ctx += `- **Students with Annual Health Records**: ${totalWithHealthRecords} (${pct}%)\n`;
    ctx += `- **Students with Infirmary History**: ${totalWithInfirmaryLogs}\n`;
    ctx += `- **Total Infirmary Visits Logged**: ${totalInfVisits}\n\n`;
    ctx += `**Health Flag Summary (Annual Checkup Data)**\n`;
    ctx += `- **Medical Findings (non-NAD)**: ${medicalFlags} students\n`;
    ctx += `- **Dental Issues**: ${dentalFlags} students\n`;
    ctx += `- **Vision Issues**: ${visionFlags} students\n`;
    ctx += `- **Total Flagged Students**: ${Math.max(medicalFlags, dentalFlags, visionFlags)} (approx, may overlap)\n\n`;
    ctx += `- **Total Teachers**: ${this.teacherByName.size}\n`;
    ctx += `- **Total Admins**: ${this.adminByName.size}\n`;

    return ctx;
  }

  getAllowedStudentIds(actorName, role) {
    const norm = this._norm(actorName);
    if (role === 'teacher') {
      const teacher = this.teacherByName.get(norm);
      if (!teacher) return [];
      return this.mappingsByTeacherId.get(teacher.TeacherId) || [];
    }
    if (role === 'parent') {
      const parentRecords = this.parentByName.get(norm) || [];
      return parentRecords.map(p => p.StudentId);
    }
    if (['admin', 'principal', 'school_admin', 'medical_admin'].includes(role)) {
      return 'ALL'; 
    }
    return [];
  }

  async buildContext(actorName, role, targetStudentName, query, sessionStudentId = null) {
    await this.ensureLoaded();
    const lowerQuery = (query || '').toLowerCase();

    if (role === 'teacher' && !targetStudentName) {
      const classCtx = await this.buildTeacherClassroomContext(actorName);
      if (classCtx) return classCtx;
    }

    if (role === 'teacher' && targetStudentName) {
      const student = this.findStudent(targetStudentName);
      if (student) {
        const allowed = this.getAllowedStudentIds(actorName, 'teacher');
        if (!allowed.includes(student.StudentId)) {
          return `## Access Denied\nYou do not have a teaching relationship with **${student.StudentName}**. You can only view health information for students in your assigned class.`;
        }
        const ctx = await this.buildStudentContext(student.StudentId);
        return this._maskForTeacher(ctx);
      }
    }

    if (role === 'parent') {
      const allowedIds = this.getAllowedStudentIds(actorName, 'parent');

      if (targetStudentName) {
        const student = this.findStudent(targetStudentName);
        if (student) {
          if (!allowedIds.includes(student.StudentId)) {
            return `## Access Denied\n**${student.StudentName}** is not registered as your child in the system. You can only view health data for your own child(ren). Please contact school administration if this is incorrect.`;
          }
          return await this.buildStudentContext(student.StudentId);
        }
      }

      if (sessionStudentId) {
        const pinned = this.studentsById.get(sessionStudentId);
        if (pinned) {
          if (!allowedIds.includes(sessionStudentId)) {
            return `## Access Denied\nYou are not authorized to view this student's data.`;
          }
          return await this.buildStudentContext(sessionStudentId);
        }
        const pinnedByName = this.findStudent(sessionStudentId);
        if (pinnedByName && allowedIds.includes(pinnedByName.StudentId)) {
          return await this.buildStudentContext(pinnedByName.StudentId);
        }
      }

      if (allowedIds.length === 1) {
        return await this.buildStudentContext(allowedIds[0]);
      }

      if (allowedIds.length > 1) {
        let ctx = `## Your Children's Health Information\n\n`;
        for (const sid of allowedIds) {
          const childCtx = await this.buildStudentContext(sid);
          if (childCtx) ctx += childCtx + '\n---\n\n';
        }
        return ctx;
      }
      return null;
    }

    if (['admin', 'principal', 'school_admin', 'medical_admin'].includes(role)) {
      if (targetStudentName) {
        const student = this.findStudent(targetStudentName);
        if (student) return await this.buildStudentContext(student.StudentId);
        return `## Student Not Found\nNo student named "${targetStudentName}" was found in the system.`;
      }
      return this.buildAdminSchoolStats();
    }

    return null;
  }

  _maskForTeacher(ctx) {
    if (!ctx) return ctx;
    return ctx
      .replace(/- \*\*Medical Finding\*\*:.+/g, '- **Medical Finding**: [Detailed records restricted — consult school nurse]')
      .replace(/- \*\*Dental Finding\*\*:.+/g, '- **Dental Finding**: [Detailed records restricted]')
      .replace(/- \*\*Vision Finding\*\*:.+/g, '- **Vision Finding**: [Detailed records restricted]')
      .replace(/- \*\*Respiratory System\*\*:.+/g, '')
      .replace(/- \*\*Skin Condition\*\*:.+/g, '');
  }
}

module.exports = new DataQueryService();
