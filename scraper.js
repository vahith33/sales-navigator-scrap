import "dotenv/config"; // ✅ MUST be first — loads .env before anything else

import { Stagehand } from "@browserbasehq/stagehand";
import { chromium } from "playwright";
import { z } from "zod";
import { createObjectCsvWriter } from "csv-writer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSION_PATH = path.join(__dirname, "session.json");

// ─── Multi-key rotator ────────────────────────────────────────────────────────
const GROQ_API_KEYS = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
].filter((k) => k && k !== "your_groq_api_key_here");

if (GROQ_API_KEYS.length === 0) {
  console.error("❌  ERROR: No valid GROQ API keys found.");
  console.error("    Add GROQ_API_KEY_1, GROQ_API_KEY_2, GROQ_API_KEY_3 to your .env file.");
  process.exit(1);
}

let _keyIndex = 0;
function getNextGroqOptions() {
  const apiKey = GROQ_API_KEYS[_keyIndex % GROQ_API_KEYS.length];
  _keyIndex++;
  return {
    modelName: "groq-llama-3.3-70b-versatile",
    modelClientOptions: { apiKey },
  };
}

// ─── Constants ───
const DEFAULT_DESIGNATION = "Technical Recruiter";
const numProfilesToScrape = parseInt(process.env.NUM_PROFILES_TO_SCRAPE || "10", 10);

// ─── Helpers ───
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const humanDelay = (min = 2000, max = 4000) =>
  delay(Math.floor(Math.random() * (max - min + 1) + min));

function sanitizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLinkedInUrl(rawUrl) {
  if (!rawUrl) return "";
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return "";
  }
}

// ─── DOM Guardrails ───
async function pruneLinkedInDOM(page) {
  await page.evaluate(() => {
    const REMOVE_SELECTORS = [
      "header", "footer", "nav", "aside", "svg", "img",
      "style", "script", "noscript", "link", "meta", "iframe",
      ".msg-overlay-container", "#global-nav", ".artdeco-toast-item",
      ".ad-banner-container", ".artdeco-modal", ".presence-entity",
    ];
    REMOVE_SELECTORS.forEach((sel) =>
      document.querySelectorAll(sel).forEach((el) => el.remove())
    );
    const KEEP_ATTRS = new Set(["class", "id", "role", "href"]);
    document.querySelectorAll("*").forEach((el) => {
      [...el.attributes].forEach((attr) => {
        if (!KEEP_ATTRS.has(attr.name)) el.removeAttribute(attr.name);
      });
    });
  });
}

const MAX_BODY_CHARS = 6000;
async function truncatePageText(page) {
  await page.evaluate((maxChars) => {
    const text = document.body.innerText || document.body.textContent || "";
    document.body.innerHTML = `<pre>${text.slice(0, maxChars)}</pre>`;
  }, MAX_BODY_CHARS);
}

// ─── Session Management ───
async function ensureLoggedIn(page, context, log) {
  log("🔍 Checking login status...");
  await page.goto("https://www.linkedin.com/feed", { waitUntil: "domcontentloaded" });
  await delay(6000); 

  if (page.url().includes("/login") || page.url().includes("/uas/")) {
    log("\n🔐 Please log into LinkedIn manually in the Chrome window...");
    const start = Date.now();
    while (Date.now() - start < 3 * 60 * 1000) {
      await delay(3000);
      if (page.url().includes("/feed") || page.url().includes("/search")) {
        log("\n✅ Login confirmed!");
        const state = await context.storageState();
        fs.writeFileSync(SESSION_PATH, JSON.stringify(state, null, 2));
        return;
      }
    }
    throw new Error("Login timeout.");
  }
}

// ─── Main Scraper Function ───
export async function runScraper(config = {}) {
  const { onLog, designation = DEFAULT_DESIGNATION } = config;
  const log = (msg) => {
    console.log(msg);
    if (onLog) onLog(msg);
  };

  let stagehand;

  try {
    log(`🚀 Searching for Hiring Members with designation: "${designation}"`);
    const chromePath = "C:/Program Files/Google/Chrome/Application/chrome.exe";

    stagehand = new Stagehand({
      env: "LOCAL",
      ...getNextGroqOptions(),
      launchOptions: {
        executablePath: chromePath,
        headless: false,
        args: ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--start-maximized"]
      },
      browserContextOptions: {
        storageState: fs.existsSync(SESSION_PATH) ? SESSION_PATH : undefined,
        viewport: null,
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
      }
    });

    await stagehand.init();
    const sPage = stagehand.page;
    const context = stagehand.context;

    await ensureLoggedIn(sPage, context, log);

    // 1. Search for Hiring Members
    const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(designation + " hiring")}`;
    log(`🔍 Navigating to search: ${searchUrl}`);
    await sPage.goto(searchUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(4000, 6000);

    // Collect profile URLs
    log("📋 Collecting profile links from search results...");
    const rawLinks = await sPage.$$eval('a[href*="/in/"]', (anchors) => anchors.map((a) => a.href));
    const profileUrls = [...new Set(rawLinks.map(normalizeLinkedInUrl).filter(u => u.includes("/in/")))].slice(0, numProfilesToScrape);

    log(`✅ Found ${profileUrls.length} profile(s).`);

    if (profileUrls.length === 0) return;

    // 2. CSV Setup
    const csvPath = path.join(__dirname, "hiring_members.csv");
    const csvWriter = createObjectCsvWriter({
      path: csvPath,
      header: [
        { id: "firstName",      title: "First Name" },
        { id: "lastName",       title: "Last Name" },
        { id: "role",           title: "Role" },
        { id: "companyName",    title: "Company Name" },
        { id: "companyAddress", title: "Company Address" },
        { id: "companyWebsite", title: "Company Website" },
        { id: "linkedinUrl",    title: "LinkedIn URL" },
      ],
      append: fs.existsSync(csvPath),
    });

    // 3. Deep Scrape Each Profile
    for (const url of profileUrls) {
      log(`\n👤 Scraping profile: ${url}`);
      try {
        await sPage.goto(url, { waitUntil: "domcontentloaded" });
        await humanDelay(3000, 5000);

        log("   ✨ Extracting person details...");
        await pruneLinkedInDOM(sPage);
        await truncatePageText(sPage);

        const personData = await sPage.extract({
          instruction: "Extract: first name, last name, job title (role), company name, and their current company LinkedIn URL.",
          schema: z.object({
            firstName:   z.string(),
            lastName:    z.string(),
            role:        z.string(),
            companyName: z.string(),
            companyUrl:  z.string().optional(),
          }),
          ...getNextGroqOptions(),
        });

        let companyInfo = { address: "N/A", website: "N/A" };

        if (personData.companyUrl && personData.companyUrl.includes("/company/")) {
          const compUrl = personData.companyUrl.startsWith("http") ? personData.companyUrl : `https://www.linkedin.com${personData.companyUrl}`;
          const aboutUrl = `${compUrl.split('?')[0].replace(/\/$/, "")}/about/`;
          
          log(`   🏢 visiting company: ${aboutUrl}`);
          try {
            await sPage.goto(aboutUrl, { waitUntil: "domcontentloaded" });
            await humanDelay(2000, 4000);
            await pruneLinkedInDOM(sPage);
            await truncatePageText(sPage);

            const compExtracted = await sPage.extract({
              instruction: "Extract: headquarters address and website URL.",
              schema: z.object({
                address: z.string().optional(),
                website: z.string().optional(),
              }),
              ...getNextGroqOptions(),
            });

            companyInfo.address = compExtracted.address || "N/A";
            companyInfo.website = compExtracted.website || "N/A";
          } catch (e) {
            log(`   ⚠️ Company page failed: ${e.message}`);
          }
        }

        await csvWriter.writeRecords([{
          firstName:      sanitizeText(personData.firstName),
          lastName:       sanitizeText(personData.lastName),
          role:           sanitizeText(personData.role),
          companyName:    sanitizeText(personData.companyName),
          companyAddress: companyInfo.address,
          companyWebsite: companyInfo.website,
          linkedinUrl:    url,
        }]);

        log(`   ✅ Saved: ${personData.firstName} ${personData.lastName}`);
      } catch (err) {
        log(`   ❌ Failed to scrape ${url}: ${err.message}`);
      }
      await humanDelay(2000, 4000);
    }

    log("\n🎉 Done! Results → hiring_members.csv");
  } catch (error) {
    log(`\n💥 Fatal Error: ${error.message}`);
  } finally {
    if (stagehand) await stagehand.close().catch(() => {});
  }
}

// CLI
if (process.argv[1] && process.argv[1].includes("scraper.js")) {
  runScraper().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}