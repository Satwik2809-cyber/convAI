/**
 * ConvAI — Client Script v2
 * Name-first identity flow + role-aware UI + grievance support.
 */

const BACKEND_URL = window.APP_CONFIG?.BACKEND_URL || 'http://localhost:3000/api/chat';
const HEALTH_URL  = (window.APP_CONFIG?.BACKEND_URL || 'http://localhost:3000/api/chat')
  .replace('/api/chat', '/health/full');

// ── DOM Elements ──────────────────────────────────────────────────────────
const sidebar          = document.getElementById('sidebar');
const sidebarToggle    = document.getElementById('sidebar-toggle');
const messagesContainer = document.getElementById('messages-container');
const welcomeScreen    = document.getElementById('welcome-screen');
const userInput        = document.getElementById('user-input');
const sendBtn          = document.getElementById('send-btn');
const historyList      = document.getElementById('history-list');
const newChatBtn       = document.getElementById('new-chat-btn');
const traceDrawer      = document.getElementById('trace-drawer');
const traceContent     = document.getElementById('trace-content');
const closeTraceBtn    = document.getElementById('close-trace');
const identityName     = document.getElementById('identity-name');
const identityRole     = document.getElementById('identity-role');
const identityAvatar   = document.getElementById('identity-avatar');
const downloadReportBtn = document.getElementById('download-report-btn');

// ── State ─────────────────────────────────────────────────────────────────
let chatHistory = [];
let SESSION_ID  = generateSessionId();
let isVerified  = false;
let verifiedName = '';
let verifiedRole = '';
let chatStarted  = false; // Track if bot has greeted yet

function generateSessionId() {
  return Math.random().toString(36).substring(2, 15) +
         Math.random().toString(36).substring(2, 15);
}

// ── Initialise ────────────────────────────────────────────────────────────
function init() {
  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', () => sidebar.classList.toggle('open'));
  }

  userInput.addEventListener('input', () => {
    userInput.style.height = 'auto';
    userInput.style.height = userInput.scrollHeight + 'px';
    sendBtn.disabled = userInput.value.trim() === '';
  });

  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener('click', sendMessage);

  if (newChatBtn) {
    newChatBtn.addEventListener('click', startNewChat);
  }

  if (closeTraceBtn) {
    closeTraceBtn.addEventListener('click', () => traceDrawer.classList.remove('open'));
  }

  if (downloadReportBtn) {
    downloadReportBtn.addEventListener('click', downloadReport);
  }

  loadLocalHistory();
  pollHealth();
  setInterval(pollHealth, 30000);

  // Auto-trigger the greeting on page load (new chat)
  triggerAutoGreeting();
}

// ── Auto-greeting ─────────────────────────────────────────────────────────
/**
 * Sends a silent "ping" to the backend to trigger the bot's opening greeting.
 * The backend identity service responds with the greeting when session state is NONE.
 */
async function triggerAutoGreeting() {
  if (chatStarted) return;
  chatStarted = true;

  // Small delay so the page finishes rendering
  await new Promise(r => setTimeout(r, 600));

  try {
    const res = await fetch(BACKEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: '__INIT__',   // special token caught by backend
        from: SESSION_ID,
        sessionId: SESSION_ID,
      }),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.success) {
      hideSuggestions();
      appendBotMessage(data.trace.response.final_text, null);
    }
  } catch (_) {
    // If backend is cold-starting, just wait — user can type first
  }
}

function hideSuggestions() {
  if (welcomeScreen && welcomeScreen.style.display !== 'none') {
    welcomeScreen.style.display = 'none';
  }
}

// ── New Chat ──────────────────────────────────────────────────────────────
function startNewChat() {
  messagesContainer.innerHTML = '';
  messagesContainer.appendChild(welcomeScreen);
  welcomeScreen.style.display = 'flex';
  userInput.value = '';
  userInput.style.height = 'auto';
  sendBtn.disabled = true;

  SESSION_ID  = generateSessionId();
  isVerified  = false;
  verifiedName = '';
  verifiedRole = '';
  chatStarted  = false;

  // Reset identity panel
  updateIdentityPanel(null, null);
  triggerAutoGreeting();
}

// ── Send Message ──────────────────────────────────────────────────────────
async function sendMessage() {
  const text = userInput.value.trim();
  if (!text) return;

  userInput.value = '';
  userInput.style.height = 'auto';
  sendBtn.disabled = true;
  hideSuggestions();

  appendUserMessage(text);
  const typingId = appendTypingIndicator();

  try {
    const response = await fetch(BACKEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, from: SESSION_ID, sessionId: SESSION_ID }),
    });

    removeTypingIndicator(typingId);

    if (!response.ok) {
      let errBody = {};
      try { errBody = await response.json(); } catch (_) {}

      if (response.status === 401) {
        appendBotMessage('🔑 **Auth Error (401):** Invalid or missing API key.', null);
      } else if (response.status === 404) {
        appendBotMessage('❌ **Not Found (404):** Endpoint not found.', null);
      } else {
        appendErrorCard('network', `Server Error (${response.status})`,
          errBody.error || response.statusText, []);
      }
      return;
    }

    const data = await response.json();

    if (data.success) {
      const trace   = data.trace;
      const finalText = trace.response.final_text;

      // Detect if identity was just verified from the response
      detectAndUpdateIdentity(finalText, trace, data.identity);

      let displayText = finalText;
      if (finalText.includes('[SHOW_DOWNLOAD]')) {
        displayText = finalText.replace(/\[SHOW_DOWNLOAD\]/g, '').trim();
        if (downloadReportBtn) downloadReportBtn.style.display = 'flex';
      }

      appendBotMessage(displayText, trace);
      saveToHistory(text, trace.interaction_id);
    } else {
      const errType = data.error_type || 'server_error';
      if (errType === 'ollama_unavailable') {
        appendErrorCard('ollama', 'Ollama LLM Unavailable', data.error, [
          'Open a terminal and run: <code>ollama serve</code>',
          'Verify: <code>ollama list</code>',
          'If model missing: <code>ollama pull tinyllama</code>',
          'Retry your message — no restart needed.',
        ]);
      } else if (errType === 'ollama_timeout') {
        appendErrorCard('timeout', 'LLM Response Timed Out', data.error, [
          'The model is still loading into memory.',
          'Wait 15–30 seconds and retry.',
        ]);
      } else {
        appendBotMessage('⚠️ ' + (data.error || 'Failed to get a response.'), null);
      }
    }
  } catch (error) {
    removeTypingIndicator(typingId);
    appendErrorCard('network', 'Cannot Reach Backend',
      `URL: <code>${BACKEND_URL}</code>`, [
        'Local dev: run <code>npm run dev</code> inside Conv-mvp/',
        `Details: ${error.message}`,
      ]);
  }
}

// ── Identity Detection & UI Update ────────────────────────────────────────
/**
 * Scan the bot reply for verification success markers and update the sidebar panel.
 */
function detectAndUpdateIdentity(text, trace, identity) {
  if (identity && identity.state === 'VERIFIED') {
    isVerified = true;
    verifiedName = identity.name;
    verifiedRole = identity.role;
    updateIdentityPanel(verifiedName, verifiedRole);
    return;
  }

  // Look for the verification success message from identityService
  const verifiedMatch = text.match(/Identity Verified[\s\S]*?Welcome.*?\*\*([^*]+)\*\*/i) ||
                        text.match(/Welcome.*?\*\*([A-Za-z ]+)\*\*/);
  const roleMatch     = text.match(/logged in as \*\*([^*]+)\*\*/i) ||
                        text.match(/relationship with \*\*([^*]+)\*\*/i);

  // Extract role from trace if available
  const traceRole = trace?.intent?.user_role ||
                    (trace?.policy?.rationale_code ? guessRoleFromRationale(trace.policy.rationale_code) : null);

  if (text.includes('Identity Verified') || text.includes('identity verified')) {
    isVerified = true;

    // Try to extract name from greeting pattern
    const nameMatch = text.match(/Welcome,\s+\*\*(?:Parent|Teacher|Admin|Principal|Medical Admin|School Admin)?\s*([^*!]+)\*\*/i);
    if (nameMatch) {
      verifiedName = nameMatch[1].trim();
    }

    // Extract role from text
    const roleInText = text.match(/\*\*(Parent|Teacher|Admin|Principal|Medical Admin|School Admin)\*\*/i);
    if (roleInText) {
      verifiedRole = roleInText[1];
    }

    updateIdentityPanel(verifiedName || 'Verified User', verifiedRole || 'Authenticated');
  }
}

function guessRoleFromRationale(code) {
  if (code.includes('PARENT')) return 'parent';
  if (code.includes('TEACHER')) return 'teacher';
  if (code.includes('ADMIN')) return 'admin';
  return null;
}

function updateIdentityPanel(name, role) {
  if (!identityName || !identityRole) return;

  if (!name) {
    identityName.textContent = 'Not verified';
    identityRole.innerHTML = `<span class="role-badge unverified"><i class="fa-circle-xmark fa-solid"></i> Unverified</span>`;
    if (identityAvatar) identityAvatar.innerHTML = '<i class="fa-user fa-solid"></i>';
    if (downloadReportBtn) downloadReportBtn.style.display = 'none';
    return;
  }

  identityName.textContent = name;

  const roleColors = {
    parent: '#4ade80',
    teacher: '#60a5fa',
    admin: '#f97316',
    principal: '#f97316',
    medical_admin: '#a78bfa',
    school_admin: '#fb923c',
  };
  const roleKey  = (role || '').toLowerCase().replace(' ', '_');
  const color    = roleColors[roleKey] || '#8ab4f8';
  const icon     = getRoleIcon(roleKey);

  identityRole.innerHTML =
    `<span class="role-badge verified" style="color:${color};border-color:${color}20;background:${color}15">` +
    `<i class="fa-solid ${icon}"></i> ${role}` +
    `</span>`;

  // Update avatar initials
  if (identityAvatar) {
    const initials = name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
    identityAvatar.textContent = initials;
    identityAvatar.style.background = `linear-gradient(135deg, ${color}40, ${color}20)`;
    identityAvatar.style.color = color;
    identityAvatar.style.border = `1px solid ${color}40`;
    identityAvatar.style.fontSize = '13px';
    identityAvatar.style.fontWeight = '600';
  }
}

function getRoleIcon(role) {
  const icons = {
    parent: 'fa-person-shelter',
    teacher: 'fa-chalkboard-user',
    admin: 'fa-user-shield',
    principal: 'fa-graduation-cap',
    medical_admin: 'fa-user-doctor',
    school_admin: 'fa-building-columns',
  };
  return icons[role] || 'fa-id-badge';
}

// ── Message Rendering ─────────────────────────────────────────────────────
function appendUserMessage(text) {
  const msgDiv = document.createElement('div');
  msgDiv.className = 'message user';
  msgDiv.innerHTML = `
    <div class="message-icon"><i class="fa-user fa-solid"></i></div>
    <div class="message-content">${escapeHtml(text)}</div>
  `;
  messagesContainer.appendChild(msgDiv);
  scrollToBottom();
}

function appendBotMessage(text, trace) {
  const msgDiv = document.createElement('div');
  msgDiv.className = 'message ai';

  let contentHtml = renderMarkdown(text);

  const traceLink = trace
    ? `<div class="trace-link" onclick='showTrace(${JSON.stringify(trace).replace(/'/g, '&apos;')})'>
         <i class="fa-magnifying-glass fa-solid"></i> View Policy Trace
       </div>`
    : '';

  msgDiv.innerHTML = `
    <div class="message-icon"><i class="fa-robot fa-solid"></i></div>
    <div class="message-content">${contentHtml}${traceLink}</div>
  `;
  messagesContainer.appendChild(msgDiv);
  scrollToBottom();
}

/** Minimal markdown renderer: bold, inline-code, line-breaks, bullets */
function renderMarkdown(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^•\s(.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)+/g, m => `<ul>${m}</ul>`)
    .replace(/\n/g, '<br>');
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// ── Typing Indicator ──────────────────────────────────────────────────────
function appendTypingIndicator() {
  const id = 'typing-' + Date.now();
  const el = document.createElement('div');
  el.className = 'message ai';
  el.id = id;
  el.innerHTML = `
    <div class="message-icon"><i class="fa-robot fa-solid"></i></div>
    <div class="message-content">
      <div class="typing">
        <div class="dot"></div><div class="dot"></div><div class="dot"></div>
      </div>
    </div>`;
  messagesContainer.appendChild(el);
  scrollToBottom();
  return id;
}

function removeTypingIndicator(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

// ── Error Card ────────────────────────────────────────────────────────────
function appendErrorCard(type, title, description, steps = []) {
  const icons   = { ollama: 'fa-robot', timeout: 'fa-clock', network: 'fa-wifi', auth: 'fa-key' };
  const colours = { ollama: '#f97316', timeout: '#eab308', network: '#ef4444', auth: '#8b5cf6' };
  const icon    = icons[type]   || 'fa-circle-exclamation';
  const colour  = colours[type] || '#ef4444';
  const stepsHtml = steps.map((s, i) => `<li><span class="step-num">${i + 1}</span>${s}</li>`).join('');

  const card = document.createElement('div');
  card.className = 'message ai';
  card.innerHTML = `
    <div class="message-icon"><i class="fa-robot fa-solid"></i></div>
    <div class="message-content error-card" style="--card-accent:${colour}">
      <div class="error-card-header">
        <i class="fa-solid ${icon}" style="color:${colour}"></i>
        <strong>${title}</strong>
      </div>
      <p class="error-card-desc">${description}</p>
      ${stepsHtml ? `<ol class="error-card-steps">${stepsHtml}</ol>` : ''}
    </div>`;
  messagesContainer.appendChild(card);
  scrollToBottom();
}

// ── Policy Trace Drawer ───────────────────────────────────────────────────
window.showTrace = (trace) => {
  if (!traceDrawer || !traceContent) return;
  traceDrawer.classList.add('open');
  traceContent.innerHTML = `
    <div class="trace-item">
      <label>Interaction ID</label>
      <div class="trace-value">${trace.interaction_id}</div>
    </div>
    <div class="trace-item">
      <label>Intent Classification</label>
      <div class="trace-value">
        Industry: <strong>${trace.intent?.industry || 'N/A'}</strong><br>
        Intent: ${trace.intent?.intent || 'N/A'}<br>
        Confidence: ${((trace.intent?.confidence || 0) * 100).toFixed(1)}%<br>
        Method: ${trace.intent?.method || 'N/A'}
      </div>
    </div>
    <div class="trace-item">
      <label>Policy Evaluation</label>
      <div class="trace-value">
        Decision: <span class="decision-badge ${trace.policy?.decision}">${trace.policy?.decision || 'N/A'}</span><br>
        Reason: ${trace.policy?.reason || 'N/A'}<br>
        Latency: ${trace.policy?.latency_ms || 0}ms
      </div>
    </div>
    <div class="trace-item">
      <label>Performance</label>
      <div class="trace-value">Total Latency: ${trace.performance?.total_latency_ms || 0}ms</div>
    </div>
    <div class="trace-item">
      <label>Raw LLM Output</label>
      <div class="trace-value" style="white-space:pre-wrap">${trace.llm_response?.raw_text || 'N/A'}</div>
    </div>`;
};

// ── Suggestion helper ─────────────────────────────────────────────────────
window.setInput = (text) => {
  userInput.value = text;
  userInput.dispatchEvent(new Event('input'));
  userInput.focus();
};

// ── History Management ────────────────────────────────────────────────────
function saveToHistory(text, id) {
  const item = { text, id, time: new Date().toISOString() };
  chatHistory.unshift(item);
  if (chatHistory.length > 20) chatHistory.pop();
  sessionStorage.setItem('convai_history', JSON.stringify(chatHistory));
  renderHistory();
}

function loadLocalHistory() {
  const saved = sessionStorage.getItem('convai_history') || sessionStorage.getItem('conversalx_history');
  if (saved) { chatHistory = JSON.parse(saved); renderHistory(); }
}

function renderHistory() {
  if (!historyList) return;
  historyList.innerHTML = '';
  chatHistory.forEach(item => {
    const div = document.createElement('div');
    div.className = 'history-item';
    div.innerHTML = `<i class="fa-message fa-regular"></i> ${escapeHtml(item.text)}`;
    div.title = item.text;
    historyList.appendChild(div);
  });
}

// ── Health Poller ─────────────────────────────────────────────────────────
async function pollHealth() {
  const bar = document.getElementById('health-bar');
  if (!bar) return;
  try {
    const res  = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(4000) });
    const data = await res.json();
    const services = {
      backend: data.backend === 'ok',
      ollama:  data.ollama  === 'ok',
      opa:     data.opa     === 'ok',
      chroma:  data.chroma  === 'ok',
    };
    bar.innerHTML = Object.entries(services).map(([name, ok]) => `
      <span class="health-pill ${ok ? 'ok' : 'err'}" title="${name}: ${ok ? 'online' : 'offline'}">
        <i class="fa-solid fa-circle"></i> ${name}
      </span>`).join('');
  } catch {
    bar.innerHTML = `<span class="health-pill err"><i class="fa-solid fa-circle"></i> backend offline</span>`;
  }
}

// ── Download Report ───────────────────────────────────────────────────────
async function downloadReport() {
  if (!isVerified) return;
  
  try {
    downloadReportBtn.disabled = true;
    downloadReportBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating...';

    const res = await fetch(BACKEND_URL.replace('/api/chat', '/api/chat/download-report'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: SESSION_ID, sessionId: SESSION_ID }),
    });

    if (!res.ok) {
      alert('Failed to generate report. Please try again.');
      return;
    }

    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition');
    let filename = 'health_report.md';
    if (disposition && disposition.indexOf('attachment') !== -1) {
      const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
      const matches = filenameRegex.exec(disposition);
      if (matches != null && matches[1]) { 
        filename = matches[1].replace(/['"]/g, '');
      }
    }

    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  } catch (err) {
    console.error('Failed to download report', err);
    alert('Failed to download report: ' + err.message);
  } finally {
    downloadReportBtn.disabled = false;
    downloadReportBtn.innerHTML = '<i class="fa-solid fa-download"></i> Download Health Report';
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
