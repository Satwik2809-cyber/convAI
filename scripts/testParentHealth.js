const http = require('http');

const BACKEND_URL = 'http://localhost:3000';
const API_KEY = 'admin123';
const ACTOR = 'Shray Mahajan'; // Must match a parent in the DB

function postMessage(text, from, role = null) {
  return new Promise((resolve, reject) => {
    const bodyObj = { text, from, channel: 'web', sessionId: 'test-session-parent' };
    if (role) bodyObj.role = role;
    const data = JSON.stringify(bodyObj);

    const req = http.request(`${BACKEND_URL}/admin/test-message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let responseBody = '';
      res.on('data', chunk => responseBody += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(responseBody)); } catch(e) { resolve(responseBody); }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function run() {
  try {
    console.log('1. Switching to Parent...');
    await postMessage('/role parent', ACTOR);
    
    // We also need to verify identity if it requires it, but /role parent might do that or not.
    console.log('\n2. Providing name to verify...');
    const hiRes = await postMessage('Shray Mahajan', ACTOR);
    console.log('Bot:', hiRes.trace?.response?.final_text);
    
    console.log('\n3. Asking for health report...');
    const reportRes = await postMessage('tell the health report of my child', ACTOR);
    console.log('Bot:', reportRes.trace?.response?.final_text);
    
    if (reportRes.trace && reportRes.trace.response && reportRes.trace.response.final_text && reportRes.trace.response.final_text.includes('Response blocked')) {
      console.log('\n❌ FAILED: Response was still blocked!');
    } else {
      console.log('\n✅ SUCCESS: Health report was displayed!');
    }
  } catch (err) {
    console.error('Test Error:', err);
  }
}

run();
