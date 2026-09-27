const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const logger = console; // Basic logger for script

const DATA_DIR = path.join(__dirname, '../data');
const SAMPLE_DATA_DIR = path.join(__dirname, '../Sample Data for ConversalX-20260502T120557Z-3-001');

const HEALTH_DATASET_XLSX = path.join(SAMPLE_DATA_DIR, 'student_health_dataset - Ashish.xlsx');
const MASTER_LIST_V2_XLSX = path.join(SAMPLE_DATA_DIR, 'Students_Master_List_v2.xlsx');
const OUTPUT_JSON = path.join(DATA_DIR, 'student_health_dataset.json');

async function ingestData() {
  logger.info('🚀 Starting Excel data ingestion...');

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // 1. Parse student_health_dataset - Ashish.xlsx
  logger.info(`Reading: ${HEALTH_DATASET_XLSX}`);
  const healthWb = XLSX.readFile(HEALTH_DATASET_XLSX);
  
  const students = XLSX.utils.sheet_to_json(healthWb.Sheets['Students']) || [];
  const parents = XLSX.utils.sheet_to_json(healthWb.Sheets['Parents']) || [];
  const teachers = XLSX.utils.sheet_to_json(healthWb.Sheets['Teachers']) || [];
  const admins = XLSX.utils.sheet_to_json(healthWb.Sheets['Admins']) || [];
  const healthRecords = XLSX.utils.sheet_to_json(healthWb.Sheets['HealthRecords']) || [];
  const mappings = XLSX.utils.sheet_to_json(healthWb.Sheets['Mappings']) || [];

  // 2. Parse Students_Master_List_v2.xlsx for Infirmary/Attendance data
  let infirmaryRecords = [];
  if (fs.existsSync(MASTER_LIST_V2_XLSX)) {
    logger.info(`Reading: ${MASTER_LIST_V2_XLSX}`);
    const masterWb = XLSX.readFile(MASTER_LIST_V2_XLSX);
    if (masterWb.Sheets['Health Report - Infirmary']) {
      infirmaryRecords = XLSX.utils.sheet_to_json(masterWb.Sheets['Health Report - Infirmary']);
    }
  } else {
    logger.warn(`Missing file: ${MASTER_LIST_V2_XLSX}. Infirmary records will be empty.`);
  }

  // 3. Compile the final JSON
  const compiledData = {
    Students: students,
    Parents: parents,
    Teachers: teachers,
    Admins: admins,
    HealthRecords: healthRecords,
    Mappings: mappings,
    InfirmaryRecords: infirmaryRecords
  };

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(compiledData, null, 2), 'utf8');
  logger.info(`✅ Successfully wrote consolidated JSON to ${OUTPUT_JSON}`);
  logger.info(`Stats:
    - Students: ${students.length}
    - Parents: ${parents.length}
    - Teachers: ${teachers.length}
    - Admins: ${admins.length}
    - Health Records: ${healthRecords.length}
    - Mappings: ${mappings.length}
    - Infirmary Records: ${infirmaryRecords.length}
  `);
}

ingestData().catch(err => {
  logger.error('❌ Ingestion failed:', err);
  process.exit(1);
});
