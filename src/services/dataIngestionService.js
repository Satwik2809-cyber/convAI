const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const llmService = require('./llmService');
const relationshipService = require('./relationshipService');

class DataIngestionService {
  /**
   * Ingest unstructured/semi-structured data, map it to the standard schema using the LLM,
   * merge it into the existing dataset, clear cache, and reload relationships.
   */
  async ingestData(rawData) {
    logger.info('📥 Starting automated data ingestion process...');

    const systemPrompt = `You are a strict JSON data extraction and mapping engine.
Your task is to extract information from the provided raw data (which may be unstructured text, clinical notes, etc.) and map it exactly into the following JSON schema.
Only extract valid records. Return ONLY the raw JSON object, without any markdown formatting, backticks, or conversational text.

Expected JSON Schema Structure:
{
  "Students": [
    { "StudentId": "SXXX", "StudentName": "...", "Class": "...", "Section": "...", "RollNo": "...", "DOB": "...", "Gender": "..." }
  ],
  "Parents": [
    { "ParentId": "PXXX", "ParentName": "...", "StudentId": "SXXX" }
  ],
  "Teachers": [
    { "TeacherId": "TXXX", "TeacherName": "..." }
  ],
  "Admins": [
    { "AdminId": "AXXX", "Name": "...", "Role": "..." }
  ],
  "Mappings": [
    { "StudentId": "SXXX", "TeacherId": "TXXX", "AdminIds": "AXXX,AYYY" }
  ],
  "HealthRecords": [
    { "RecordId": "HRXXX", "StudentId": "SXXX", "HeightCm": 100, "WeightKg": 30, "MedicalFinding": "...", "DentalFinding": "...", "VisionFinding": "...", "Recommendation": "..." }
  ],
  "InfirmaryLogs": [
    { "LogId": "ILXXX", "StudentId": "SXXX", "Date": "YYYY-MM-DD", "Complaint": "...", "ActionTaken": "..." }
  ]
}

If a category is empty or no data applies, return an empty array for that key.`;

    let mappedData;
    try {
      const response = await llmService.generateResponse(systemPrompt, rawData, { maxTokens: 4000, temperature: 0.1 });
      
      // Clean the response from potential markdown backticks
      const cleanJsonStr = response.replace(/```json/g, '').replace(/```/g, '').trim();
      mappedData = JSON.parse(cleanJsonStr);
      logger.info('✅ Data successfully mapped by LLM');
    } catch (error) {
      logger.error('❌ Failed to parse or map data with LLM', { error: error.message });
      throw new Error(`LLM Mapping failed: ${error.message}`);
    }

    // Load existing data
    const datasetPath = path.join(__dirname, '../../data/student_health_dataset.json');
    let existingData = {};
    try {
      if (fs.existsSync(datasetPath)) {
        existingData = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
      }
    } catch (error) {
      logger.error('❌ Failed to read existing dataset', { error: error.message });
      throw error;
    }

    // Merge logic
    const mergeArrays = (existingArr = [], newArr = [], keyField) => {
      const merged = [...existingArr];
      newArr.forEach(newItem => {
        const index = merged.findIndex(e => e[keyField] === newItem[keyField]);
        if (index > -1) {
          // Update existing
          merged[index] = { ...merged[index], ...newItem };
        } else {
          // Append new
          merged.push(newItem);
        }
      });
      return merged;
    };

    existingData.Students = mergeArrays(existingData.Students, mappedData.Students, 'StudentId');
    existingData.Parents = mergeArrays(existingData.Parents, mappedData.Parents, 'ParentId');
    existingData.Teachers = mergeArrays(existingData.Teachers, mappedData.Teachers, 'TeacherId');
    existingData.Admins = mergeArrays(existingData.Admins, mappedData.Admins, 'AdminId');
    existingData.Mappings = mergeArrays(existingData.Mappings, mappedData.Mappings, 'StudentId'); // Assuming 1 mapping per student
    existingData.HealthRecords = mergeArrays(existingData.HealthRecords, mappedData.HealthRecords, 'RecordId');
    existingData.InfirmaryLogs = mergeArrays(existingData.InfirmaryLogs, mappedData.InfirmaryLogs, 'LogId');

    // Write back to file
    try {
      fs.writeFileSync(datasetPath, JSON.stringify(existingData, null, 2), 'utf8');
      logger.info('✅ Dataset updated and written to disk');
    } catch (error) {
      logger.error('❌ Failed to write updated dataset to disk', { error: error.message });
      throw error;
    }

    // Invalidate cached reports
    this._clearReportsCache();

    // Reload relationships
    try {
      await relationshipService.loadData();
      logger.info('✅ Relationships and Data Source successfully reloaded');
    } catch (error) {
      logger.error('❌ Failed to reload relationships', { error: error.message });
      throw error;
    }

    return { success: true, message: 'Data ingested, dataset updated, and relationships automatically reloaded.' };
  }

  _clearReportsCache() {
    const reportsDir = path.join(__dirname, '../../data/reports');
    if (fs.existsSync(reportsDir)) {
      const files = fs.readdirSync(reportsDir);
      for (const file of files) {
        fs.unlinkSync(path.join(reportsDir, file));
      }
      logger.info('🗑️ Cleared cached reports to reflect new data.');
    }
  }
}

module.exports = new DataIngestionService();
