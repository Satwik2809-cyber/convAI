/**
 * ConvAI — Document Processor
 * 
 * Handles extraction of text from various file formats:
 * - PDF: Using pdf-parse
 * - Word (.docx): Using mammoth
 * - Excel (.xlsx): Using xlsx (Row-to-Document strategy)
 */

const fs = require('fs/promises');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const ExcelJS = require('exceljs');
const logger = require('./logger');

class DocumentProcessor {
  /**
   * Process a file based on its extension.
   * @param {string} filePath 
   * @returns {Promise<string[]>} — Returns an array of text chunks
   */
  async processFile(filePath) {
    const ext = filePath.split('.').pop().toLowerCase();
    
    try {
      switch (ext) {
        case 'pdf':
          return await this._processPdf(filePath);
        case 'docx':
          return await this._processWord(filePath);
        case 'xlsx':
        case 'xls':
          return await this._processExcel(filePath);
        default:
          logger.warn(`📄 Unsupported file type: ${ext} at ${filePath}`);
          return [];
      }
    } catch (error) {
      logger.error(`📄 Failed to process file ${filePath}`, { error: error.message });
      return [];
    }
  }

  /**
   * Extract text from PDF and split into paragraphs.
   */
  async _processPdf(filePath) {
    const dataBuffer = await fs.readFile(filePath);
    const data = await pdf(dataBuffer);
    return this._chunkText(data.text);
  }

  /**
   * Extract text from Word and split into paragraphs.
   */
  async _processWord(filePath) {
    const result = await mammoth.extractRawText({ path: filePath });
    return this._chunkText(result.value);
  }

  /**
   * Process Excel using Row-to-Document strategy via ExcelJS.
   * Each row becomes a searchable chunk with headers prepended.
   */
  async _processExcel(filePath) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const allChunks = [];

    workbook.eachSheet((worksheet, sheetId) => {
      const sheetName = worksheet.name;
      const headers = [];
      
      // Extract headers from the first row
      const firstRow = worksheet.getRow(1);
      if (!firstRow || !firstRow.values || firstRow.values.length === 0) return;

      firstRow.eachCell((cell, colNumber) => {
        headers[colNumber] = cell.text;
      });

      // Process data rows (starting from row 2)
      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // Skip header row

        const rowContentParts = [];
        row.eachCell((cell, colNumber) => {
          const header = headers[colNumber];
          const val = cell.text;
          if (header && val) {
            rowContentParts.push(`${header}: ${val}`);
          }
        });

        const rowContent = rowContentParts.join(' | ');
        if (rowContent) {
          allChunks.push(`[Sheet: ${sheetName}, Row: ${rowNumber}] ${rowContent}`);
        }
      });
    });

    return allChunks;
  }

  /**
   * Simple paragraph-based chunker for unstructured text.
   */
  _chunkText(text) {
    if (!text) return [];
    
    // Split by double newlines or single newlines followed by a capital letter
    return text
      .split(/\n\s*\n/)
      .map(p => p.trim())
      .filter(p => p.length > 50); // Ignore tiny fragments
  }
}

module.exports = new DocumentProcessor();
