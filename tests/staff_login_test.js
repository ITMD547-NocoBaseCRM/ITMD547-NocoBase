/* 

AUTOMATED TESTING by Carolyn Carney 
Nocobase CRM Project, ITMD 547

🤖 Mission: Verify Staff Tech can log into Beauty Within CRM
 Agent login.test.js — reporting for duty

*/

// 🕵️‍♀️ Agent RoboGrrl - Staff Login Test
// Mission: Verify Staff Tech can access Beauty Within CRM

const puppeteer = require('puppeteer');
require('dotenv').config();

// Helper function for delays — same trick as BingBot
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

(async () => {
  console.log('🚀 Launching login test...');
  const browser = await puppeteer.launch({ headless: false }); // 👁️ Watch the ninja work
  const [page] = await browser.pages();

  try {
    // 🎯 Navigate to the CRM
    await page.goto(process.env.BASE_URL, { waitUntil: 'networkidle2' });

    await delay(3000 + Math.random() * 2020)

    // 🔐 Type credentials with human-like rhythm (BingBot-style delay)
    console.log('⌨️ Typing username...');
    await page.type('input[placeholder="Username/Email"]', process.env.STAFF_EMAIL, {
      delay: 104 + Math.random() * 79
    });

    await delay(3500 + Math.random() * 500); // Natural pause before password

    console.log('⌨️ Typing password...');
    await page.type('input[placeholder="Password"]', process.env.STAFF_PASSWORD, {
      delay: 89 + Math.random() * 156
    });

    await delay(2800 + Math.random() * 600); // Pause before clicking, like double-checking

    // 🖱️ Click Sign In
    console.log('🔓 Submitting login...');
    await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2' }),
    page.keyboard.press('Enter'),
    ]);  

    console.log('🔓 Submitted login...');

    // ⏳ Wait for dashboard to load
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // 📸 Screenshot as evidence
    await page.screenshot({ path: 'staff_test_screenshots/login-success.png' });
    console.log('✅ PASS — Staff Tech logged in successfully');

  } catch (err) {
    await page.screenshot({ path: 'staff_test_screenshots/login-failure.png' });
    console.log('❌ FAIL — Staff Tech could not log in', err.message);

  } finally {
    await delay (10000) //quick pause to view page
    await browser.close();
    console.log('🕶️ Mission complete. Browser closed.');
  }
})();