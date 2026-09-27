const http = require('http');

const BACKEND_URL = 'http://localhost:3000';
const API_KEY = 'admin123';
const ACTOR = 'Siya Lata';

function postMessage(text, from, role = null) {
  return new Promise((resolve, reject) => {
    const bodyObj = { text, from, sessionId: 'test-session-123' };
    if (role) bodyObj.role = role;
    
    const body = JSON.stringify(bodyObj);
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: '/admin/test-message',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': API_KEY,
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } 
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function runTests() {
  console.log("1. Starting chat as Teacher (pre-verified)");
  const res1 = await postMessage('Hello', ACTOR, 'teacher');
  console.log("Teacher Response:", res1.body.trace?.response?.final_text?.slice(0, 100) + '...');
  
  console.log("\n2. Asking to download report");
  const res2 = await postMessage('I want to download my report', ACTOR);
  console.log("Download Response:", res2.body.trace?.response?.final_text?.slice(0, 100) + '...');
  const hasDownloadLink = res2.body.trace?.response?.final_text?.includes('Click here to download your report');
  console.log("Download link present?", hasDownloadLink ? "✅ YES" : "❌ NO");

  console.log("\n3. Switching Role to Parent");
  const res3 = await postMessage('/role parent', ACTOR);
  console.log("Switch Role Response:", res3.body.trace?.response?.final_text?.slice(0, 100) + '...');
}

runTests().catch(console.error);
