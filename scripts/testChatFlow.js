const fetch = require('node-fetch'); // Assumes node-fetch is available, or use native fetch if Node 18+

async function runTest() {
  const BACKEND_URL = 'http://localhost:3000/api/chat';
  const SESSION_ID = 'test-session-' + Date.now();
  
  async function sendMessage(text) {
    console.log(`\nUser: ${text}`);
    const res = await fetch(BACKEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, from: SESSION_ID, sessionId: SESSION_ID }),
    });
    const data = await res.json();
    if (data.success) {
      console.log(`Bot: ${data.trace.response.final_text}`);
    } else {
      console.log(`Error: ${JSON.stringify(data)}`);
    }
  }

  // 1. Init
  await sendMessage('__INIT__');
  
  // 2. Teacher name
  await sendMessage('Siya Lata');
  
  // 3. Teacher overview
  await sendMessage('Show me my class details');
  
  // 4. Parent name (new session)
  const PARENT_SESSION = 'test-session-parent-' + Date.now();
  async function sendParentMessage(text) {
    console.log(`\nUser (Parent): ${text}`);
    const res = await fetch(BACKEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, from: PARENT_SESSION, sessionId: PARENT_SESSION }),
    });
    const data = await res.json();
    if (data.success) {
      console.log(`Bot (Parent): ${data.trace.response.final_text}`);
    } else {
      console.log(`Error: ${JSON.stringify(data)}`);
    }
  }
  
  await sendParentMessage('__INIT__');
  await sendParentMessage('Shray Mahajan');
  await sendParentMessage('Give me the health report');
  await sendParentMessage('Give me the health report for Saksham');
}

runTest().catch(console.error);
