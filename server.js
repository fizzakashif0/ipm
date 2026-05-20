
// ===============================
// MONDAY GERMAN ADDRESS VALIDATION
// Powered by OpenAI only (no Google Maps)
// ===============================
require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ===============================
// 🔧 CONFIG — use environment variables
// ===============================
const  MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ;
const BOARD_ID = 5094616802;

// ===============================
// 📋 COLUMN IDs
// ===============================
const COLUMN_IDS = {
  address_line1: "text_mm2dtvgh",
  address_line2: "text_mm2dheb2",
  pincode:       "text_mm2dn7pz",
  ort:           "text_mm2dnddg",
  landkreise:    "text_mm2dpdbv",
  bundesland:    "text_mm2dqnjq",
  country:       "text_mm2dzznp",
  status:        "color_mm2dv4wa"
};

// ===============================
// 📥 FETCH ITEM FROM MONDAY
// ===============================
async function getItemData(itemId) {
  const query = `
    query {
      items(ids: ${itemId}) {
        column_values {
          id
          text
        }
      }
    }
  `;

  const res = await axios.post(
    "https://api.monday.com/v2",
    { query },
    { headers: { Authorization: MONDAY_API_TOKEN } }
  );

  return res.data.data.items[0].column_values;
}

// ===============================
// 🗺️ MAP RAW COLUMNS TO READABLE FIELDS
// ===============================
function mapColumns(columns) {
  const data = {};
  columns.forEach(col => {
    data[col.id] = col.text;
  });

  return {
    address_line1: data[COLUMN_IDS.address_line1] || "",
    address_line2: data[COLUMN_IDS.address_line2] || "",
    pincode:       data[COLUMN_IDS.pincode] || "",
    ort:           data[COLUMN_IDS.ort] || "",
    landkreise:    data[COLUMN_IDS.landkreise] || "",
    bundesland:    data[COLUMN_IDS.bundesland] || "",
    country:       data[COLUMN_IDS.country] || ""
  };
}

// ===============================
// 🤖 OPENAI — VALIDATE + FILL ADDRESS
//
// Sends the full address to GPT and asks it to:
// 1. Check if the address is a real, valid German address
// 2. Check if the pincode matches the street/city
// 3. Fill in ort, landkreise, bundesland, country
//
// Returns a structured JSON response
// ===============================
async function validateAndFillWithGPT(fields) {
  const addressBlock = [
    fields.address_line1,
    fields.address_line2,
    fields.pincode,
    fields.ort,
    fields.bundesland,
    fields.country
  ]
    .filter(Boolean)
    .join(", ");

  const prompt = `
You are a German address validation expert with deep knowledge of German postal codes, cities, districts, and states.

You will be given an address entered by a user. Your job is to:
1. Determine if this is a real, plausible German address (street name + house number format looks valid)
2. Verify that the postal code (PLZ) matches the city/area for Germany
3. Extract and correct the following fields based on what you know:
   - ort: the city or town name
   - landkreise: the district (Landkreis or kreisfreie Stadt)
   - bundesland: the German federal state
   - country: should always be "Germany"

User-entered address:
  Address Line 1 : ${fields.address_line1}
  Address Line 2 : ${fields.address_line2 || "(not provided)"}
  Pincode (PLZ)  : ${fields.pincode}
  Ort (City)     : ${fields.ort || "(not provided)"}
  Bundesland     : ${fields.bundesland || "(not provided)"}
  Country        : ${fields.country || "(not provided)"}

Rules:
- If the pincode does NOT match the city/area in Germany, set is_valid to false and explain in reason
- If the street address looks completely implausible or fictional, set is_valid to false
- If minor fields like ort/bundesland are missing or wrong, still set is_valid to true but correct them
- Be strict about pincode vs city mismatches — this is the most important check
- Always fill in ort, landkreise, bundesland, country based on the pincode if possible

Return ONLY a raw JSON object, no explanation, no markdown, no backticks:
{
  "is_valid": true or false,
  "reason": "short explanation if invalid, or 'Address is valid' if valid",
  "ort": "...",
  "landkreise": "...",
  "bundesland": "...",
  "country": "Germany"
}
`;

  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  const raw = res.data.choices[0].message.content.trim();
  const cleaned = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

// ===============================
// 📝 UPDATE MONDAY ITEM
// ===============================
async function updateItem(itemId, status,  fields = {}) {
  const columnValues = {
    [COLUMN_IDS.status]: { label: status }
  };

  if (fields.ort)        columnValues[COLUMN_IDS.ort]        = fields.ort;
  if (fields.landkreise) columnValues[COLUMN_IDS.landkreise] = fields.landkreise;
  if (fields.bundesland) columnValues[COLUMN_IDS.bundesland] = fields.bundesland;
  if (fields.country)    columnValues[COLUMN_IDS.country]    = fields.country;

  const mutation = `
    mutation {
      change_multiple_column_values(
        item_id: ${itemId},
        board_id: ${BOARD_ID},
        column_values: "${JSON.stringify(columnValues).replace(/"/g, '\\"')}"
      ) {
        id
      }
    }
  `;

  await axios.post(
    "https://api.monday.com/v2",
    { query: mutation },
    { headers: { Authorization: MONDAY_API_TOKEN } }
  );
}

// ===============================
// 🔁 LOOP PREVENTION
// Skip if the change came from our own writes
// ===============================
function shouldSkip(body) {
  const event = body.event || {};
  const changedIds = [
    body.columnId,
    body.column_id,
    event.columnId,
    event.column_id,
    event.column && event.column.id
  ].filter(Boolean).map(String);

  if (changedIds.length === 0) return false;

  const skipColumns = [
    COLUMN_IDS.status,
    COLUMN_IDS.ort,
    COLUMN_IDS.landkreise,
    COLUMN_IDS.bundesland,
    COLUMN_IDS.country
  ];

  return changedIds.every(id => skipColumns.includes(id));
}

// ===============================
// 🌐 WEBHOOK ENDPOINT
// ===============================
app.post("/webhook", async (req, res) => {
  try {
    // Monday URL verification challenge
    if (req.body.challenge) {
      return res.json({ challenge: req.body.challenge });
    }

    // Skip loop triggers
    if (shouldSkip(req.body)) {
      return res.status(200).json({ skipped: true, reason: "Avoided loop" });
    }

    const event  = req.body.event;
    const itemId = event.pulseId;

    console.log("🔔 Webhook triggered for item:", itemId);

    // --- FETCH DATA FROM MONDAY ---
    const columns = await getItemData(itemId);
    const fields  = mapColumns(columns);

    console.log("📋 Fields:", fields);

    // --- CHECK MANDATORY FIELDS ---
    if (!fields.address_line1 || !fields.pincode) {
      await updateItem(itemId, "Invalid", "Address Line 1 and Pincode are mandatory");
      return res.sendStatus(200);
    }

    // --- OPENAI: VALIDATE + FILL ---
    console.log("🤖 Sending address to OpenAI for validation...");
    const result = await validateAndFillWithGPT(fields);

    console.log("🤖 OpenAI result:", result);

    if (!result.is_valid) {
      // Address failed validation
      await updateItem(itemId, "Invalid", result.reason);
      return res.sendStatus(200);
    }

    // Address is valid — write back filled fields
    await updateItem(
      itemId,
      "Valid",
      result.reason || "Address validated and fields auto-filled successfully",
      {
        ort:        result.ort,
        landkreise: result.landkreise,
        bundesland: result.bundesland,
        country:    result.country
      }
    );

    console.log("✅ Done! Monday updated.");
    res.sendStatus(200);

  } catch (err) {
    console.error("❌ Error:", err.message);
    res.sendStatus(500);
  }
});

// ===============================
// 🏓 HEALTH CHECK — FOR UPTIME MONITORING
// ===============================
app.get("/ping", (req, res) => {
  res.status(200).send("OK");
});

// ===============================
// 🚀 START SERVER
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});