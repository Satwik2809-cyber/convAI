const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const interactionService = require('../services/interactionService');
const sessionService = require('../services/sessionService');
const identityService = require('../services/identityService');

/**
 * POST /api/chat — Process a message from the Web UI.
 * Body: { "text": "...", "from": "<session-id>", "sessionId": "<session-id>" }
 *
 * Special case: text === "__INIT__" triggers the auto-greeting without going through
 * the full LLM pipeline. Used by the client on page load to start the identity flow.
 */
router.post('/', async (req, res) => {
  const { text, from = 'anonymous', role, sessionId } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'Body must contain { "text": "..." }' });
  }

  // ── Auto-greeting for fresh sessions ──────────────────────────────────
  if (text === '__INIT__') {
    return res.json({ success: true, trace: null });
  }

  // ── Switch role feature ───────────────────────────────────────────────
  if (text.trim().toLowerCase() === 'switch role') {
    try {
      const sessionKey = sessionId ? `${from}_${sessionId}` : from;
      const session = await sessionService.getOrCreateSession(sessionKey);
      identityService.switchRole(session, null);
      
      const greeting = identityService.getGreeting();
      return res.json({
        success: true,
        trace: {
          interaction_id: `switch-${Date.now()}`,
          intent: { industry: 'unknown', intent: 'switch_role', confidence: 1, method: 'switch' },
          policy: { decision: 'PROCEED', reason: 'Switch Role', latency_ms: 0 },
          response: { final_text: greeting },
          performance: { total_latency_ms: 0 },
          llm_response: { raw_text: '' },
        },
      });
    } catch (err) {
      logger.error('Switch role failed', { error: err.message });
      return res.status(500).json({ success: false, error: err.message });
    }
  }


  // ── Normal message flow ───────────────────────────────────────────────
  try {
    const trace = await interactionService.processMessage(from, text, 'web-' + Date.now(), 'web', role, sessionId);
    const sessionKey = sessionId ? `${from}_${sessionId}` : from;
    const session = await sessionService.getOrCreateSession(sessionKey);
    res.json({
      success: true,
      identity: session.identity,
      trace: {
        interaction_id: trace.interaction_id,
        intent: trace.intent,
        policy: trace.policy,
        response: trace.response,
        performance: trace.performance,
        llm_response: trace.llm_response,
      },
    });
  } catch (error) {
    const rawCode = error.code || error.cause?.code || '';
    const isConnRefused = rawCode === 'ECONNREFUSED' || rawCode === 'ERR_NETWORK';
    const isTimeout     = rawCode === 'ETIMEDOUT' || rawCode === 'ECONNABORTED';

    let errorType = 'server_error';
    let userMessage = error.message;

    if (isTimeout) {
      errorType = 'llm_timeout';
      userMessage = 'LLM timed out. Please wait and retry.';
    } else if (isConnRefused) {
      errorType = 'llm_unavailable';
      userMessage = 'LLM service is unreachable. Please check network or API keys.';
    } else if (error.isLLMError) {
      errorType = 'llm_error';
    }

    logger.error('Web chat endpoint failed', {
      error: error.message,
      code: rawCode,
      errorType,
    });

    res.status(500).json({
      success: false,
      error_type: errorType,
      error: userMessage,
    });
  }
});

/**
 * GET/POST /api/chat/download-report — Generate and download a formatted report.
 */
router.all('/download-report', async (req, res) => {
  const from = req.query.from || req.body.from;
  const sessionId = req.query.sessionId || req.body.sessionId;
  if (!from) {
    return res.status(400).json({ error: 'Missing parameter: from' });
  }

  try {
    const sessionKey = sessionId ? `${from}_${sessionId}` : from;
    const session = await sessionService.getOrCreateSession(sessionKey);
    
    if (!session.identity || session.identity.state !== 'VERIFIED') {
      return res.status(403).json({ error: 'User identity is not verified. Please log in first.' });
    }

    const { name: actorId, role: userRole } = session.identity;
    const relationshipService = require('../services/relationshipService');
    const dataset = relationshipService.rawDataset; // Get raw dataset

    let reportMarkdown = '';
    let filename = '';

    if (userRole === 'teacher') {
      const rels = relationshipService.getRelationships(actorId);
      const allowedStudents = (rels && rels['TEACHES']) ? rels['TEACHES'] : [];
      
      reportMarkdown += `# 📊 ConvAI Classroom Health Report\n\n`;
      reportMarkdown += `**Teacher Name:** ${actorId}  \n`;
      reportMarkdown += `**Generated At:** ${new Date().toLocaleString()}  \n`;
      reportMarkdown += `**Scope:** Assigned Students (${allowedStudents.length} total)  \n\n`;
      reportMarkdown += `## ⚠️ Classroom Attention Summary\n`;
      reportMarkdown += `Below is the list of students in your assigned class and their health attention flags. Detailed clinical descriptions are omitted per privacy governance.\n\n`;
      reportMarkdown += `| Student Name | Roll No | Height / Weight | Attention Flags | Recommendation |\n`;
      reportMarkdown += `| :--- | :--- | :--- | :--- | :--- |\n`;

      const studentsMap = {};
      (dataset.Students || []).forEach(s => { studentsMap[s.StudentId] = s; });

      let flaggedCount = 0;
      (dataset.HealthRecords || []).forEach(hr => {
        const student = studentsMap[hr.StudentId];
        if (student && allowedStudents.includes(student.StudentName)) {
          const flags = [];
          if (hr.MedicalFinding && !hr.MedicalFinding.includes('NAD')) flags.push('Medical Finding');
          if (hr.DentalFinding && !hr.DentalFinding.includes('NAD')) flags.push('Dental Finding');
          if (hr.VisionFinding && !hr.VisionFinding.includes('Normal')) flags.push('Vision Finding');

          const hasFlags = flags.length > 0;
          if (hasFlags) flaggedCount++;

          reportMarkdown += `| **${student.StudentName}** | ${student.RollNo || 'N/A'} | ${hr.HeightCm || '-'}cm / ${hr.WeightKg || '-'}kg | ${hasFlags ? '⚠️ ' + flags.join(', ') : '✅ No Flags'} | ${hr.Recommendation || 'None'} |\n`;
        }
      });

      reportMarkdown += `\n**Total Flagged Students needing classroom attention:** ${flaggedCount} of ${allowedStudents.length}\n`;
      filename = `${actorId.replace(/\s+/g, '_')}_Class_Report.md`;

    } else if (userRole === 'parent') {
      const rels = relationshipService.getRelationships(actorId);
      const allowedStudents = (rels && rels['HAS_CHILD']) ? rels['HAS_CHILD'] : [];

      // If viewing a specific child, attempt to serve their original .docx report
      if (session.currentTargetStudent) {
        const childName = session.currentTargetStudent;
        const student = (dataset.Students || []).find(s => s.StudentName === childName);
        if (student) {
          const hr = (dataset.HealthRecords || []).find(h => h.StudentId === student.StudentId);
          if (hr && hr.SourceFile) {
            const searchBase = path.join(__dirname, '../../Sample Data for ConversalX-20260502T120557Z-3-001/Class folder - Health Report');
            let foundPath = null;
            const searchRecursive = (dir) => {
              if (foundPath) return;
              try {
                const files = fs.readdirSync(dir, { withFileTypes: true });
                for (const file of files) {
                  if (file.isDirectory()) searchRecursive(path.join(dir, file.name));
                  else if (file.name === hr.SourceFile) foundPath = path.join(dir, file.name);
                }
              } catch (e) {}
            };
            if (fs.existsSync(searchBase)) {
              searchRecursive(searchBase);
            }
            if (foundPath) {
              logger.info(`🗂️ Serving original .docx for ${childName}: ${foundPath}`);
              return res.download(foundPath, `${childName.replace(/\s+/g, '_')}_Health_Report.docx`);
            }
          }
        }
      }

      // Fallback: Generate markdown report
      reportMarkdown += `# 🏥 ConvAI Student Health & Medical Report\n\n`;
      reportMarkdown += `**Parent Name:** ${actorId}  \n`;
      reportMarkdown += `**Generated At:** ${new Date().toLocaleString()}  \n\n`;

      const studentsMap = {};
      (dataset.Students || []).forEach(s => { studentsMap[s.StudentId] = s; });

      (dataset.HealthRecords || []).forEach(hr => {
        const student = studentsMap[hr.StudentId];
        if (student && allowedStudents.includes(student.StudentName)) {
          reportMarkdown += `## 🧑‍🎓 Student Profile: ${student.StudentName}\n`;
          reportMarkdown += `- **Class & Section:** ${student.Class} ${student.Section}\n`;
          reportMarkdown += `- **Roll Number:** ${student.RollNo || 'N/A'}\n`;
          reportMarkdown += `- **DOB:** ${student.DOB || 'N/A'}\n`;
          reportMarkdown += `- **Gender:** ${student.Gender || 'N/A'}\n\n`;

          reportMarkdown += `### 📏 Vital Stats\n`;
          reportMarkdown += `- **Height:** ${hr.HeightCm} cm\n`;
          reportMarkdown += `- **Weight:** ${hr.WeightKg} kg\n`;
          const bmi = (hr.WeightKg / ((hr.HeightCm / 100) ** 2)).toFixed(1);
          reportMarkdown += `- **Calculated BMI:** ${bmi}\n\n`;

          reportMarkdown += `### 🩺 Diagnostics & Findings\n`;
          reportMarkdown += `- **General Medical Finding:** ${hr.MedicalFinding || 'NAD'}\n`;
          reportMarkdown += `- **Dental Examination:** ${hr.DentalFinding || 'NAD'}\n`;
          reportMarkdown += `- **Vision Checkup:** ${hr.VisionFinding || 'Normal'}\n`;
          reportMarkdown += `- **Actionable Recommendation:** ${hr.Recommendation || 'None'}\n\n`;

          // Add infirmary logs
          const visits = (dataset.InfirmaryLogs || []).filter(log => log.StudentId === student.StudentId);
          reportMarkdown += `### 📋 Infirmary Visit Logs (${visits.length} visits)\n`;
          if (visits.length > 0) {
            reportMarkdown += `| Date | Complaint | Treatment / Action Taken |\n`;
            reportMarkdown += `| :--- | :--- | :--- |\n`;
            visits.forEach(v => {
              reportMarkdown += `| ${v.Date || 'N/A'} | ${v.Complaint || 'N/A'} | ${v.ActionTaken || 'N/A'} |\n`;
            });
          } else {
            reportMarkdown += `*No recent infirmary visits recorded.*\n`;
          }
          reportMarkdown += `\n---\n\n`;
        }
      });

      filename = `${actorId.replace(/\s+/g, '_')}_Child_Report.md`;

    } else { // Admin or similar
      reportMarkdown += `# 🛡️ ConvAI Master School Health Report\n\n`;
      reportMarkdown += `**Admin Name:** ${actorId}  \n`;
      reportMarkdown += `**Generated At:** ${new Date().toLocaleString()}  \n`;
      reportMarkdown += `**Scope:** All School Records  \n\n`;

      const studentsMap = {};
      (dataset.Students || []).forEach(s => { studentsMap[s.StudentId] = s; });

      reportMarkdown += `## 📊 High-Level Metrics\n`;
      reportMarkdown += `- **Total Students:** ${dataset.Students ? dataset.Students.length : 0}\n`;
      reportMarkdown += `- **Total Health Records:** ${dataset.HealthRecords ? dataset.HealthRecords.length : 0}\n`;
      reportMarkdown += `- **Total Infirmary Visits:** ${dataset.InfirmaryLogs ? dataset.InfirmaryLogs.length : 0}\n\n`;

      reportMarkdown += `### 🏫 Classroom Summary Table\n`;
      reportMarkdown += `| Student ID | Student Name | Class | Section | Medical finding | Dental finding | Vision finding |\n`;
      reportMarkdown += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;

      (dataset.HealthRecords || []).slice(0, 50).forEach(hr => { // Limit to top 50 for download size convenience
        const student = studentsMap[hr.StudentId];
        if (student) {
          reportMarkdown += `| ${student.StudentId} | ${student.StudentName} | ${student.Class} | ${student.Section} | ${hr.MedicalFinding || 'NAD'} | ${hr.DentalFinding || 'NAD'} | ${hr.VisionFinding || 'Normal'} |\n`;
        }
      });
      reportMarkdown += `\n*(Showing top 50 student records. Full dataset contains ${dataset.Students ? dataset.Students.length : 0} students)*\n`;

      filename = `School_Health_Master_Report.md`;
    }

    const reportsDir = path.join(__dirname, '../../data/reports');
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }
    
    const filePath = path.join(reportsDir, filename);
    
    // If file doesn't exist, create it
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, reportMarkdown, 'utf8');
      logger.info(`📝 Report generated and cached at ${filePath}`);
    } else {
      logger.info(`🗂️ Serving cached physical report from ${filePath}`);
    }

    res.download(filePath, filename);
  } catch (error) {
    logger.error('Failed to generate report download', { error: error.message });
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

module.exports = router;
