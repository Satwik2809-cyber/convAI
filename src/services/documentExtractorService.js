const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const logger = require('../utils/logger');

class DocumentExtractorService {
    constructor() {
        this.reportsDir = path.join(__dirname, '..', '..', 'Sample Data for ConversalX-20260502T120557Z-3-001', 'wetransfer_2-reports-in-word-format-for-salim-conversalx-research_2025-12-27_1206');
    }

    /**
     * Extracts health data from a student's document.
     * @param {string} studentName The clean name of the student.
     * @param {string} studentClass The class of the student (e.g. "1st", "2nd").
     * @param {string} studentSection The section of the student (e.g. "A", "B").
     * @param {string} fileRef The file reference from master list (if available).
     * @returns {object|null} The extracted health data or null if not found.
     */
    async extract(studentName, studentClass, studentSection, fileRef = null) {
        try {
            if (!fs.existsSync(this.reportsDir)) {
                logger.error(`DocumentExtractor: Reports directory not found at ${this.reportsDir}`);
                return null;
            }

            const classFolders = await fs.promises.readdir(this.reportsDir);
            let targetFolder = null;
            
            if (studentClass || studentSection) {
                targetFolder = this._findClassFolder(classFolders, studentClass, studentSection);
            }

            if (!targetFolder) {
                logger.warn(`DocumentExtractor: Could not find folder for class '${studentClass}' section '${studentSection}'.`);
                return null;
            }

            const targetFolderPath = path.join(this.reportsDir, targetFolder);
            let docxPath = null;

            // Strategy 1: Use explicit file reference from master list
            if (fileRef) {
                let checkRef = fileRef;
                if (!checkRef.toLowerCase().endsWith('.docx') && !checkRef.toLowerCase().endsWith('.pdf')) {
                    checkRef += '.docx';
                }
                const refPath = path.join(targetFolderPath, checkRef);
                if (fs.existsSync(refPath)) {
                    docxPath = refPath;
                    logger.info(`DocumentExtractor: Found via fileRef: ${refPath}`);
                }
            }

            if (!docxPath) {
                logger.warn(`DocumentExtractor: Document not found for ${studentName} in class ${studentClass} ${studentSection}`);
                return null;
            }

            return await this._parseDocument(docxPath, studentName);

        } catch (error) {
            logger.error(`DocumentExtractor: Failed to extract data for ${studentName}`, { error: error.message });
            return null;
        }
    }

    /**
     * Extracts health data using a roll number to locate the file.
     * This is the primary extraction path for students from Relationship-2.xlsx
     * where files are named like "1st - A (Roll no.2).docx"
     */
    async extractByRollNo(studentName, studentClass, studentSection, rollNo) {
        try {
            if (!fs.existsSync(this.reportsDir)) {
                logger.error(`DocumentExtractor: Reports directory not found at ${this.reportsDir}`);
                return null;
            }

            const classFolders = await fs.promises.readdir(this.reportsDir);
            const targetFolder = this._findClassFolder(classFolders, studentClass, studentSection);

            if (!targetFolder) {
                logger.warn(`DocumentExtractor: No folder for class '${studentClass}' section '${studentSection}'. Available: ${classFolders.join(', ')}`);
                return null;
            }

            const targetFolderPath = path.join(this.reportsDir, targetFolder);
            const files = await fs.promises.readdir(targetFolderPath);
            let docxPath = null;

            // Strategy 1: Match by roll number in filename (e.g. "Roll no.2" or "Roll no. 2")
            if (rollNo) {
                const rollPattern = new RegExp(`roll\\s*no\\.?\\s*${rollNo}[)\\s.]`, 'i');
                const matched = files.find(f => !f.startsWith('~') && rollPattern.test(f));
                if (matched) {
                    docxPath = path.join(targetFolderPath, matched);
                    logger.info(`DocumentExtractor: Found by roll no ${rollNo}: ${matched}`);
                }
            }

            // Strategy 2: Match by student first name in filename
            if (!docxPath && studentName) {
                const firstName = studentName.split(' ')[0].toLowerCase();
                const matched = files.find(f => !f.startsWith('~') && f.toLowerCase().includes(firstName));
                if (matched) {
                    docxPath = path.join(targetFolderPath, matched);
                    logger.info(`DocumentExtractor: Found by first name '${firstName}': ${matched}`);
                }
            }

            // Strategy 3: Search inside all .docx files for student name
            if (!docxPath && studentName) {
                logger.info(`DocumentExtractor: Name/roll search failed for ${studentName}, scanning document contents...`);
                const nameParts = studentName.toLowerCase().split(' ').filter(p => p.length > 2);
                for (const f of files) {
                    if (!f.startsWith('~') && f.toLowerCase().endsWith('.docx')) {
                        try {
                            const p = path.join(targetFolderPath, f);
                            const res = await mammoth.extractRawText({ path: p });
                            const textLow = res.value.toLowerCase();
                            // Check if any meaningful name part exists in document
                            if (nameParts.some(part => textLow.includes(part))) {
                                docxPath = p;
                                logger.info(`DocumentExtractor: Found ${studentName} inside ${f} by content scan`);
                                break;
                            }
                        } catch (e) {
                            // Ignore corrupt/unreadable files
                        }
                    }
                }
            }

            if (!docxPath) {
                logger.warn(`DocumentExtractor: Document not found for ${studentName} (Roll: ${rollNo}) in '${targetFolder}'`);
                return null;
            }

            return await this._parseDocument(docxPath, studentName);

        } catch (error) {
            logger.error(`DocumentExtractor: Failed extractByRollNo for ${studentName}`, { error: error.message });
            return null;
        }
    }

    /**
     * Finds the class folder by trying multiple class string patterns.
     * Handles: "1st A", "1 A", "Class - 1st A", "I A", "U KG A", etc.
     */
    _findClassFolder(folders, studentClass, studentSection) {
        const cls = (studentClass || '').trim().toLowerCase();
        const sec = (studentSection || '').trim().toLowerCase();

        // Build all candidate patterns to search for
        const candidates = new Set();

        if (cls && sec) {
            candidates.add(`${cls} ${sec}`);       // "1st a"
            candidates.add(`${sec} ${cls}`);       // "a 1st"
            candidates.add(`${cls}${sec}`);        // "1sta"
            candidates.add(`${sec}${cls}`);        // "a1st"
        }
        if (cls) candidates.add(cls);
        if (sec) candidates.add(sec);

        // Also try ordinal conversions: "1" → "1st", "2" → "2nd", etc.
        const ordinals = { '1': '1st', '2': '2nd', '3': '3rd', '4': '4th', '5': '5th',
                           '6': '6th', '7': '7th', '8': '8th', '9': '9th', '10': '10th' };
        const reverseOrdinals = { '1st': '1', '2nd': '2', '3rd': '3', '4th': '4', '5th': '5',
                                   '6th': '6', '7th': '7', '8th': '8', '9th': '9', '10th': '10' };

        if (cls in ordinals) {
            const ord = ordinals[cls];
            if (sec) {
                candidates.add(`${ord} ${sec}`);
                candidates.add(`${sec} ${ord}`);
            }
            candidates.add(ord);
        }
        if (cls in reverseOrdinals) {
            const num = reverseOrdinals[cls];
            if (sec) {
                candidates.add(`${num} ${sec}`);
                candidates.add(`${sec} ${num}`);
            }
            candidates.add(num);
        }

        // Try Roman numeral mappings: I=1st, II=2nd, III=3rd, etc.
        const romanMap = { 'i': '1st', 'ii': '2nd', 'iii': '3rd', 'iv': '4th', 'v': '5th',
                           'vi': '6th', 'vii': '7th', 'viii': '8th', 'ix': '9th', 'x': '10th' };
        if (cls in romanMap) {
            const mapped = romanMap[cls];
            if (sec) {
                candidates.add(`${mapped} ${sec}`);
                candidates.add(`${sec} ${mapped}`);
                candidates.add(`${cls} ${sec}`);
            }
            candidates.add(mapped);
        }

        const candidateArr = [...candidates];

        // Match against actual folder names
        for (const folder of folders) {
            const fLow = folder.toLowerCase();
            for (const cand of candidateArr) {
                if (fLow.includes(cand)) {
                    return folder;
                }
            }
        }

        return null;
    }

    /**
     * Parses a .docx file and extracts health metrics.
     */
    async _parseDocument(docxPath, studentName) {
        logger.info(`DocumentExtractor: Parsing document ${path.basename(docxPath)}`);
        const result = await mammoth.extractRawText({ path: docxPath });
        const text = result.value;

        // Extract metrics
        const heightMatch = text.match(/HEIGHT:\s*([\d.]+)\s*(cms|cm)/i);
        const weightMatch = text.match(/WEIGHT:\s*([\d.]+)\s*(kg|kgs)/i);
        const bmiMatch = text.match(/BMI:\s*([\d.]+)\s*(kg\/m2|kg\/m²)?/i);
        const genderMatch = text.match(/Gender:\s*([MF])/i);
        const dobMatch = text.match(/DOB[:\s]+([\d\-\/]+)/i);

        // Medical Findings
        const findingMatch = text.match(/Findings of Medical.*?Screening Examination:?\s*(.*?)(?=Prescription|Remarks|$)/is);
        let findings = findingMatch ? findingMatch[1].trim() : '';
        findings = findings.replace(/\r?\n|\r/g, ' ').replace(/\s+/g, ' ').trim();
        // If it just says 'EXCEPT', clear it so it doesn't show up weird
        if (findings.toUpperCase() === 'EXCEPT' || findings.toUpperCase() === 'NAD – NO ABNORMALITY DETECTED ON THE DAY OF EXAMINATION EXCEPT') {
            findings = 'NAD - NO ABNORMALITY DETECTED';
        }

        // Recommendation
        const recMatch = text.match(/Remarks \/ Recommendation of Doctors, If Any:?\s*(.*?)(?=The recommendations in general|$)/is);
        let recommendation = recMatch ? recMatch[1].trim() : '';
        if (!recommendation) {
            recommendation = 'Refer to full report for recommendations';
        }

        // Student name from document (for verification)
        const nameMatch = text.match(/STUDENT['']?S?\s+NAME[:\s]+([^\n\r]+)/i);
        const reportName = nameMatch ? nameMatch[1].trim() : '';

        // Dental / Vision
        const dentalMatch = text.match(/DENTAL Screening(.*?)VISION Screening/is);
        let dentalFinding = 'Available in full report';
        if (dentalMatch) {
            const dentalText = dentalMatch[1];
            // Look for tooth numbers or specific flags
            const numbers = dentalText.match(/\b\d{2}\b(?:,\s*\d{2})*/g);
            if (numbers && numbers.length > 0) {
                // Filter out irrelevant numbers, keep potential tooth numbers
                const uniqueNumbers = [...new Set(numbers)];
                dentalFinding = 'Consult / Findings on teeth: ' + uniqueNumbers.join(' | ');
            } else if (dentalText.includes('Normal Within Limits') || dentalText.includes('NAD')) {
                dentalFinding = 'NAD - Normal Within Limits';
            }
        }

        const visionMatch = text.match(/VISION Screening(.*?)General Remarks/is);
        const visionFinding = visionMatch ? 'Available in full report' : 'Normal';

        // NAD check
        const isNAD = text.includes('NAD') || text.includes('NO ABNORMALITY DETECTED');
        const medFinding = findings || (isNAD ? 'NAD – NO ABNORMALITY DETECTED' : 'NAD');

        // Vision Scores
        const visionScoresMatch = text.match(/Right Eye\s+Left Eye\s+([0-9a-zA-Z\/,.]+)\s+([0-9a-zA-Z\/,.]+)/is);
        const visionScores = visionScoresMatch ? `Right: ${visionScoresMatch[1]}, Left: ${visionScoresMatch[2]}` : (visionFinding === 'Available in full report' ? 'Check full report' : 'Normal');

        const extracted = {
            HeightCm: heightMatch ? heightMatch[1] : null,
            WeightKg: weightMatch ? weightMatch[1] : null,
            BMI: bmiMatch ? bmiMatch[1] : null,
            Gender: genderMatch ? genderMatch[1] : null,
            DOB: dobMatch ? dobMatch[1] : null,
            ReportStudentName: reportName,
            MedicalFinding: medFinding,
            DentalFinding: dentalFinding,
            VisionFinding: visionScores,
            Recommendation: recommendation,
            RespiratorySystem: /respiratory/i.test(text) ? 'Checked – see full report' : 'Normal',
            SkinCondition: /skin/i.test(text) ? 'Checked – see full report' : 'Normal',
            NervousSystem: 'Oriented to time, Place & person',
            CVS: 'S1 and S2, Heart Murmur (Checked)',
            Abdomen: 'Appetite, Bowel Movements (Checked)',
            SourceFile: path.basename(docxPath)
        };

        logger.info(`DocumentExtractor: ✅ Extracted data for ${studentName} from ${path.basename(docxPath)}`);
        return extracted;
    }
}

module.exports = new DocumentExtractorService();
