const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');
const mammoth = require('mammoth');

const args = process.argv.slice(2);
const parentName = args[0] || "Mrs. Charmi Shah";

const baseDir = String.raw`C:\Users\shrey\Downloads\Conv-mvp\Conv-mvp\Sample Data for ConversalX-20260502T120557Z-3-001`;
const relPath = path.join(baseDir, 'Relationship-2.xlsx');
const masterPath = path.join(baseDir, 'Students_Master_List_v2.xlsx');
const reportsDir = path.join(baseDir, 'wetransfer_2-reports-in-word-format-for-salim-conversalx-research_2025-12-27_1206');

async function processReport() {
    // 1. Read Relationship-2.xlsx
    const relWorkbook = xlsx.readFile(relPath);
    const relSheet = relWorkbook.Sheets[relWorkbook.SheetNames[0]];
    const relData = xlsx.utils.sheet_to_json(relSheet, {defval: ''});

    // Find the student by parent name
    let studentObj = relData.find(r => {
        const fullParent = (r.Parent_First_Name + ' ' + r.Parent_Second_Name).trim().toLowerCase();
        return fullParent.includes(parentName.toLowerCase()) || parentName.toLowerCase().includes(fullParent);
    });

    if (!studentObj) {
        console.log(`Parent '${parentName}' not found in Relationship-2.xlsx`);
        process.exit(1);
    }

    const studentFullName = (studentObj.Student_First_Name + ' ' + studentObj.Student_Second_Name).trim();
    console.log(`Found Student from Relationship: ${studentFullName}`);

    // Clean up prefixes (Ms., Mr., etc.)
    const cleanStudentName = studentFullName.replace(/^(Ms\.|Mr\.|Mrs\.)\s*/i, '').trim();

    // 2. Read Students_Master_List_v2.xlsx
    const masterWorkbook = xlsx.readFile(masterPath);
    const masterSheetName = masterWorkbook.SheetNames[0];
    const masterSheet = masterWorkbook.Sheets[masterSheetName];
    const masterData = xlsx.utils.sheet_to_json(masterSheet, {defval: ''});

    // Find student in master list
    const masterRecordIndex = masterData.findIndex(r => r['Student Name'] && r['Student Name'].toLowerCase().includes(cleanStudentName.toLowerCase()));

    if (masterRecordIndex === -1) {
        console.log(`Student ${cleanStudentName} not found in Master List.`);
        process.exit(1);
    }

    const masterRecord = masterData[masterRecordIndex];
    const studentClass = masterRecord['Class'];
    let fileRef = masterRecord['File / Reference'];
    
    console.log(`Matched in Master List -> Class: ${studentClass}, File: ${fileRef}`);

    if (!fileRef) {
        console.log("No file reference found for student.");
        process.exit(1);
    }
    
    // Ensure fileRef has .docx extension if missing
    if (!fileRef.toLowerCase().endsWith('.docx') && !fileRef.toLowerCase().endsWith('.pdf')) {
        fileRef += '.docx';
    }

    // 3. Construct File Path
    const classFolders = fs.readdirSync(reportsDir);
    // Find the folder that contains the class name (e.g. "1st A")
    const targetFolder = classFolders.find(f => f.toLowerCase().includes(studentClass.toLowerCase()));

    if (!targetFolder) {
        console.log(`Class folder for '${studentClass}' not found in ${reportsDir}.`);
        process.exit(1);
    }

    const docxPath = path.join(reportsDir, targetFolder, fileRef);
    if (!fs.existsSync(docxPath)) {
        console.log(`File ${docxPath} does not exist!`);
        process.exit(1);
    }

    console.log(`Reading report: ${docxPath}`);

    try {
        // 4. Parse the document
        const result = await mammoth.extractRawText({path: docxPath});
        const text = result.value;
        
        // Extract metrics
        const heightMatch = text.match(/HEIGHT:\s*([\d.]+)\s*(cms|cm)/i);
        const weightMatch = text.match(/WEIGHT:\s*([\d.]+)\s*(kg|kgs)/i);
        const bmiMatch = text.match(/BMI:\s*([\d.]+)\s*(kg\/m2)/i);
        const genderMatch = text.match(/Gender:\s*([MF])/i);
        
        // Extract Medical Findings
        const findingMatch = text.match(/Findings of Medical.*?Examination:(.*?)(?=Prescription)/is);
        let findings = findingMatch ? findingMatch[1].trim() : '';
        findings = findings.replace(/\r?\n|\r/g, ' ').replace(/\s+/g, ' '); // Clean newlines

        const extractedData = {
            "Health_Height": heightMatch ? heightMatch[1] + ' cm' : '',
            "Health_Weight": weightMatch ? weightMatch[1] + ' kg' : '',
            "Health_BMI": bmiMatch ? bmiMatch[1] : '',
            "Health_Gender": genderMatch ? genderMatch[1] : '',
            "Health_Findings": findings
        };

        console.log("Extracted Data:", JSON.stringify(extractedData, null, 2));

        // 5. Update Master Data
        Object.assign(masterData[masterRecordIndex], extractedData);

        // Convert back to sheet and overwrite
        const newSheet = xlsx.utils.json_to_sheet(masterData);
        masterWorkbook.Sheets[masterSheetName] = newSheet;
        
        xlsx.writeFile(masterWorkbook, masterPath);
        console.log(`\nSuccessfully appended health data to ${masterPath} for ${cleanStudentName}!`);

    } catch (err) {
        console.error("Error extracting text:", err);
    }
}

processReport();
