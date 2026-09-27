import pandas as pd
import json
import os
import math

def clean(val):
    if pd.isna(val): return ''
    if isinstance(val, str): return val.strip()
    return str(val).strip()

def is_empty(val):
    return clean(val) == ''

def main():
    dir_path = 'Sample Data for ConversalX-20260502T120557Z-3-001'
    ashish_file = os.path.join(dir_path, 'student_health_dataset - Ashish.xlsx')
    master_file = os.path.join(dir_path, 'Students_Master_List_v2.xlsx')
    rel_file = os.path.join(dir_path, 'Relationship-2.xlsx')
    
    out_file = 'data/student_health_dataset.json'
    
    # Storage
    students = {}  # id -> dict
    parents = []
    teachers = {}  # name -> dict
    admins = {}    # id -> dict
    health_records = {} # student_id -> dict
    infirmary = []
    mappings = {} # student_id -> {TeacherId, AdminIds}

    student_name_to_id = {}
    
    print("Loading Base Data (Ashish.xlsx)...")
    df_s = pd.read_excel(ashish_file, sheet_name='Students')
    for _, r in df_s.iterrows():
        sid = clean(r.get('StudentId'))
        name = clean(r.get('StudentName'))
        students[sid] = {
            'StudentId': sid,
            'StudentName': name,
            'RollNo': clean(r.get('RollNo')),
            'Class': clean(r.get('Class')),
            'Section': clean(r.get('Section')),
            'DOB': clean(r.get('DOB')),
            'Gender': clean(r.get('Gender'))
        }
        if name: student_name_to_id[name.lower()] = sid
        
    df_p = pd.read_excel(ashish_file, sheet_name='Parents')
    for _, r in df_p.iterrows():
        parents.append({
            'ParentId': clean(r.get('ParentId')),
            'StudentId': clean(r.get('StudentId')),
            'ParentName': clean(r.get('ParentName')),
            'Relation': clean(r.get('Relation')),
            'Phone': clean(r.get('Phone'))
        })

    df_t = pd.read_excel(ashish_file, sheet_name='Teachers')
    for _, r in df_t.iterrows():
        tid = clean(r.get('TeacherId'))
        name = clean(r.get('TeacherName'))
        teachers[name.lower()] = {
            'TeacherId': tid,
            'TeacherName': name,
            'AssignedClass': clean(r.get('AssignedClass')),
            'Section': clean(r.get('Section')),
            'Role': clean(r.get('Role'))
        }

    df_a = pd.read_excel(ashish_file, sheet_name='Admins')
    for _, r in df_a.iterrows():
        aid = clean(r.get('AdminId'))
        admins[aid] = {
            'AdminId': aid,
            'Name': clean(r.get('Name')),
            'Role': clean(r.get('Role'))
        }
        
    df_m = pd.read_excel(ashish_file, sheet_name='Mappings')
    for _, r in df_m.iterrows():
        sid = clean(r.get('StudentId'))
        mappings[sid] = {
            'StudentId': sid,
            'TeacherId': clean(r.get('TeacherId')),
            'AdminIds': clean(r.get('AdminIds'))
        }
        
    df_h = pd.read_excel(ashish_file, sheet_name='HealthRecords')
    for _, r in df_h.iterrows():
        sid = clean(r.get('StudentId'))
        health_records[sid] = {
            'HealthRecordId': clean(r.get('HealthRecordId')),
            'StudentId': sid,
            'HeightCm': clean(r.get('HeightCm')),
            'WeightKg': clean(r.get('WeightKg')),
            'BMI': clean(r.get('BMI')),
            'MedicalFinding': clean(r.get('MedicalFinding')),
            'DentalFinding': clean(r.get('DentalFinding')),
            'VisionFinding': clean(r.get('VisionFinding')),
            'RespiratorySystem': clean(r.get('RespiratorySystem')),
            'SkinCondition': clean(r.get('SkinCondition')),
            'Recommendation': clean(r.get('Recommendation'))
        }

    # Helper to get/create student
    def get_student(name, default_class='', default_section='', default_roll='', default_dob='', default_gender=''):
        name = str(name).strip()
        # Remove prefixes
        clean_name = name.replace('Ms. ', '').replace('Mr. ', '').replace('Ms ', '').replace('Mr ', '').strip()
        name_lower = clean_name.lower()
        if not name_lower or name_lower in ['student name', 'student_name', 'nan']: return None
        if name_lower in student_name_to_id:
            return student_name_to_id[name_lower]
        
        sid = f"STU{len(students) + 1:04d}"
        students[sid] = {
            'StudentId': sid,
            'StudentName': clean_name,
            'RollNo': default_roll,
            'Class': default_class,
            'Section': default_section,
            'DOB': default_dob,
            'Gender': default_gender
        }
        student_name_to_id[name_lower] = sid
        return sid

    def get_teacher(name):
        name = str(name).strip()
        if not name or name.lower() in ['class teacher', 'class teacher name', 'class_teacher', 'nan']: return None
        name_lower = name.lower()
        if name_lower in teachers:
            return teachers[name_lower]['TeacherId']
        tid = f"TCH{len(teachers) + 1:03d}"
        teachers[name_lower] = {
            'TeacherId': tid,
            'TeacherName': name,
            'AssignedClass': '',
            'Section': '',
            'Role': 'Class Teacher'
        }
        return tid
        
    print("Loading Master Data (Students_Master_List_v2.xlsx)...")
    try:
        df_master = pd.read_excel(master_file, sheet_name='Students Master List')
        for _, r in df_master.iterrows():
            name = clean(r.get('Student Name'))
            if not name: continue
            dob_gender = clean(r.get('DOB / Age & Sex'))
            gender = 'M' if 'boy' in dob_gender.lower() or 'male' in dob_gender.lower() else 'F' if 'girl' in dob_gender.lower() or 'female' in dob_gender.lower() else 'Unknown'
            
            sid = get_student(name, clean(r.get('Class')), '', clean(r.get('Roll No')), dob_gender, gender)
            
            father = clean(r.get("Father's Name"))
            if father and father.lower() != 'not provided in source data':
                parents.append({'ParentId': f"PAR{len(parents)+1:04d}", 'StudentId': sid, 'ParentName': father, 'Relation': 'Father', 'Phone': ''})
                
            mother = clean(r.get("Mother's Name"))
            if mother and mother.lower() != 'not provided in source data':
                parents.append({'ParentId': f"PAR{len(parents)+1:04d}", 'StudentId': sid, 'ParentName': mother, 'Relation': 'Mother', 'Phone': ''})
                
            teacher_name = clean(r.get('Class Teacher'))
            tid = get_teacher(teacher_name)
            if tid:
                if sid not in mappings:
                    mappings[sid] = {'StudentId': sid, 'TeacherId': tid, 'AdminIds': 'ADM001'}
                else:
                    mappings[sid]['TeacherId'] = tid
    except Exception as e:
        print("Error reading master list:", e)

    print("Loading Medical Data...")
    try:
        df_med = pd.read_excel(master_file, sheet_name='Health Report - Medical')
        for _, r in df_med.iterrows():
            name = clean(r.get('Student Name'))
            if not name: continue
            sid = get_student(name)
            if sid not in health_records:
                health_records[sid] = {
                    'HealthRecordId': f"HLT{len(health_records)+1:04d}",
                    'StudentId': sid,
                    'HeightCm': clean(r.get('Height')),
                    'WeightKg': clean(r.get('Weight')),
                    'BMI': clean(r.get('BMI')),
                    'MedicalFinding': clean(r.get("Doctor's Remarks / Recommendation")),
                    'DentalFinding': clean(r.get("Caries (Tooth #)")),
                    'VisionFinding': clean(r.get("Vision (R/L Eye)")),
                    'RespiratorySystem': 'Normal',
                    'SkinCondition': 'Normal',
                    'Recommendation': clean(r.get("Doctor's Remarks / Recommendation"))
                }
    except Exception as e:
        print("Error reading medical:", e)

    print("Loading Infirmary Data...")
    try:
        df_inf = pd.read_excel(master_file, sheet_name='Health Report - Infirmary')
        for _, r in df_inf.iterrows():
            infirmary.append({
                'Date': str(r.get('Date'))[:10] if not is_empty(r.get('Date')) else '',
                'Student Name': clean(r.get('Student Name')),
                'Age & Sex': clean(r.get('Age & Sex')),
                'Class': clean(r.get('Class')),
                'Roll No': clean(r.get('Roll No')),
                'Class Teacher': clean(r.get('Class Teacher')),
                'Health Issue': clean(r.get('Health Issue')),
                'Action Taken': clean(r.get('Action Taken')),
                'Medicine Given': clean(r.get('Medicine Given')),
                'Way Forward / Plan': clean(r.get('Way Forward / Plan'))
            })
    except Exception as e:
        print("Error reading infirmary:", e)

    print("Loading Relationships (Relationship-2.xlsx)...")
    try:
        df_rel = pd.read_excel(rel_file)
        for _, r in df_rel.iterrows():
            sf = clean(r.get('Student_First_Name')).replace('Ms.', '').replace('Mr.', '').replace('Ms', '').replace('Mr', '').strip()
            sl = clean(r.get('Student_Second_Name'))
            sname = f"{sf} {sl}".strip()
            if not sname: continue
            
            # FIX: In Relationship-2.xlsx, columns are SWAPPED:
            #   'Section' column actually contains the grade number (e.g. '1st', '2nd')
            #   'Grade'   column actually contains the section letter (e.g. 'A', 'B')
            # So: class = '{Section} {Grade}' = e.g. '1st A'
            grade_num = clean(r.get('Section'))  # e.g. '1st', '2nd'
            section_letter = clean(r.get('Grade'))  # e.g. 'A', 'B'
            
            # FIX: Sr. No in Relationship-2 IS the student Roll No
            # (confirmed: Aaryushri Joshi = Sr. No 2, file = '1st - A (Roll no.2).docx')
            roll_no = str(int(r.get('Sr. No'))) if not is_empty(r.get('Sr. No')) else ''
            
            sid = get_student(sname, grade_num, section_letter, roll_no)
            # Ensure RollNo is stored even if student already existed
            if sid and sid in students and not students[sid].get('RollNo') and roll_no:
                students[sid]['RollNo'] = roll_no
            
            pf = clean(r.get('Parent_First_Name')).replace('Mrs.', '').replace('Mr.', '').replace('Mrs', '').replace('Mr', '').strip()
            pl = clean(r.get('Parent_Second_Name'))
            pname = f"{pf} {pl}".strip()
            if pname:
                parents.append({'ParentId': f"PAR{len(parents)+1:04d}", 'StudentId': sid, 'ParentName': pname, 'Relation': 'Parent', 'Phone': clean(r.get('Parent_Mobile'))})
                
            tf = clean(r.get('Teacher_First_Name'))
            tl = clean(r.get('Teacher_Second_Name'))
            tname = f"{tf} {tl}".strip()
            tid = get_teacher(tname)
            
            if tid:
                if sid not in mappings:
                    mappings[sid] = {'StudentId': sid, 'TeacherId': tid, 'AdminIds': 'ADM001'}
                else:
                    mappings[sid]['TeacherId'] = tid
            
            # Admin Extraction from Relationship-2
            af = clean(r.get('Admin_First_Name')).replace('Mr.', '').replace('Ms.', '').replace('Mrs.', '').strip()
            al = clean(r.get('Admin_Second_Name'))
            aname = f"{af} {al}".strip()
            
            if aname:
                found_aid = None
                for aid, a in admins.items():
                    if a['Name'].lower() == aname.lower():
                        found_aid = aid
                        break
                
                if not found_aid:
                    found_aid = f"ADM{len(admins)+1:03d}"
                    admins[found_aid] = {'AdminId': found_aid, 'Name': aname, 'Role': 'Principal/Admin'}
                
                if sid in mappings:
                    mappings[sid]['AdminIds'] = found_aid
                    
    except Exception as e:
        print("Error reading relationships:", e)

    # Convert to lists
    final_data = {
        "Students": list(students.values()),
        "Parents": parents,
        "Teachers": list(teachers.values()),
        "Admins": list(admins.values()),
        "HealthRecords": list(health_records.values()),
        "Mappings": list(mappings.values()),
        "InfirmaryRecords": infirmary
    }
    
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(final_data, f, indent=2)
        
    print(f"Data ingested successfully to {out_file}!")
    print(f"Students: {len(students)}, Parents: {len(parents)}, Teachers: {len(teachers)}, Infirmary: {len(infirmary)}")

if __name__ == '__main__':
    main()
