require('dotenv').config();
const { OpenAI } = require('openai');
const axios = require('axios');

async function testOpenAI() {
  const start = Date.now();
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL,
      messages: [{ role: 'user', content: 'Say hello world' }],
      max_tokens: 50,
    });
    console.log('OpenAI:', res.choices[0].message.content, `(${Date.now() - start}ms)`);
  } catch (e) {
    console.error('OpenAI Error:', e.message);
  }
}

async function testGemini() {
  const start = Date.now();
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const res = await axios.post(url, {
      contents: [{ parts: [{ text: 'Say hello world' }] }]
    });
    console.log('Gemini:', res.data.candidates[0].content.parts[0].text, `(${Date.now() - start}ms)`);
  } catch (e) {
    console.error('Gemini Error:', e.message);
  }
}

async function run() {
  console.log('Testing LLMs...');
  await testOpenAI();
  await testGemini();
}

run();
