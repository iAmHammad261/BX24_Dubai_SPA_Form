const express = require("express");
const path = require("path");
const fs = require("fs");
const https = require("https");
const puppeteer = require("puppeteer");
const { PDFDocument } = require("pdf-lib");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// Serves index.html, spaform.html, and spa-skeleton.html (fetched by the handler at runtime)
app.use(express.static(path.join(__dirname)));

// Install / setup screen — Bitrix calls this on app install
app.all("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// The SPA Form tab rendered inside the Deal
app.all("/spaform.html", (req, res) => {
  res.sendFile(path.join(__dirname, "spaform.html"));
});

// Same-origin proxy for the unit image (cdn.bitrix24.com sends no CORS header,
// so the image can only be embedded into the PDF when fetched via this proxy).
app.get("/image-proxy", (req, res) => {
  const target = req.query.url || "";
  let host;
  try {
    host = new URL(target).hostname.toLowerCase();
  } catch (e) {
    return res.status(400).send("Bad url");
  }

  const allowedHosts = [
    "cdn.bitrix24.com",
    "cdn.bitrix24.de",
    "cdn.bitrix24.eu",
  ];
  if (!allowedHosts.includes(host))
    return res.status(403).send("Host not allowed");

  https
    .get(encodeURI(target), (upstream) => {
      if (upstream.statusCode && upstream.statusCode >= 400) {
        upstream.resume();
        return res.status(502).send("Upstream HTTP " + upstream.statusCode);
      }
      res.setHeader(
        "Content-Type",
        upstream.headers["content-type"] || "image/png",
      );
      res.setHeader("Cache-Control", "public, max-age=86400");
      upstream.pipe(res);
    })
    .on("error", () => res.status(502).send("Fetch failed"));
});

// ── Read a static asset from disk and return it as a data-URI (for header/cover) ──
function fileDataUrl(file, mime) {
  try {
    const buf = fs.readFileSync(path.join(__dirname, file));
    return "data:" + mime + ";base64," + buf.toString("base64");
  } catch (e) {
    return "";
  }
}

// ── Server-side PDF rendering with headless Chrome ──
// Receives the fully-rendered SPA HTML (CSS + body, unit image already inlined),
// renders it with real Chrome pagination + running header/footer, prepends the
// cover page, and returns the finished PDF as base64.
app.post("/render-pdf", async (req, res) => {
  const { html, spsl, purchaserCount } = req.body || {};
  if (!html) return res.status(400).json({ error: "missing html" });

  const ref = String(spsl || "").replace(/[<>&"]/g, "");
  const logoL = fileDataUrl("logo-pci.png", "image/png");
  const logoR = fileDataUrl("logo-southlofts.png", "image/png");

  const initialsLabel =
    Number(purchaserCount) > 1 ? "Buyers Initials" : "Buyer Initial";

  let browser;
  try {
    const launchOpts = {
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    };
    // Full puppeteer ships its own Chromium and finds it automatically. Only
    // override the path if an explicit one is provided via the environment.
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    browser = await puppeteer.launch(launchOpts);
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 60000 });

    const headerTemplate =
      '<div style="width:100%; box-sizing:border-box; padding:4mm 10mm 0; font-family:Arial,sans-serif; -webkit-print-color-adjust:exact;">' +
      '<div style="font-style:italic; font-size:8px; color:#777;">' +
      ref +
      "</div>" +
      '<div style="display:flex; justify-content:space-between; align-items:center; margin-top:1.5mm;">' +
      (logoL
        ? '<img src="' + logoL + '" style="height:9mm;">'
        : "<span></span>") +
      (logoR
        ? '<img src="' + logoR + '" style="height:12mm;">'
        : "<span></span>") +
      "</div>" +
      "</div>";

    const footerTemplate =
      '<div style="width:100%; box-sizing:border-box; padding:0 10mm; font-family:Arial,sans-serif; font-size:9px; display:flex; justify-content:space-between;">' +
      '<span>Page <span class="pageNumber"></span></span>' +
      "<span>" +
      initialsLabel +
      ": __________</span>" +
      "</div>";

    const bodyPdf = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: headerTemplate,
      footerTemplate: footerTemplate,
      margin: { top: "30mm", bottom: "16mm", left: "10mm", right: "10mm" },
    });
    await browser.close();
    browser = null;

    // Prepend the cover page (full-page image, no header/footer, unnumbered).
    const merged = await PDFDocument.create();
    try {
      const coverBytes = fs.readFileSync(path.join(__dirname, "cover.png"));
      const coverImg = await merged.embedPng(coverBytes);
      const A4W = 595.28,
        A4H = 841.89; // points
      const cover = merged.addPage([A4W, A4H]);
      cover.drawImage(coverImg, { x: 0, y: 0, width: A4W, height: A4H });
    } catch (e) {
      console.error("[SPA] cover embed failed. Full error:", e);
      console.error("[SPA] error stack:", e && e.stack);
    }

    const bodyDoc = await PDFDocument.load(bodyPdf);
    const pages = await merged.copyPages(bodyDoc, bodyDoc.getPageIndices());
    pages.forEach(function (p) {
      merged.addPage(p);
    });

    const out = await merged.save();
    res.json({ base64: Buffer.from(out).toString("base64") });
  } catch (e) {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
    }
    console.error("[SPA] render-pdf error:", e);
    res.status(500).send(String(e && e.message ? e.message : e));
  }
});

app.listen(PORT, () => {
  console.log(`Dubai SPA Form server running on port ${PORT}`);
});
