import express from "express";
import mysql from "mysql2/promise";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import helmet from "helmet";
import morgan from "morgan";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// ---------------------------
// Middlewares
// ---------------------------
app.use(cors());
app.use(express.json());
app.use(helmet()); // security headers
app.use(morgan("dev")); // logging


// ---------------------------
// MySQL connection (Pool for prod)
// ---------------------------
let db;
async function initDB() {
  try {
    db = await mysql.createPool({
      host: process.env.DB_HOST || "localhost",
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASSWORD || "",
      database: process.env.DB_NAME || "job_recommender",
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });
    console.log("✅ Database connected");
    // console.log(DB_PASSWORD);
  } catch (err) {
    console.error("❌ DB connection error:", err.message);
    process.exit(1);
  }
}
await initDB();

// ---------------------------
// OpenAI setup
// ---------------------------
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY is missing!");
  process.exit(1);
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------
// Helpers
// ---------------------------
function safeParse(value) {
  if (!value) return [];
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }
  return value;
}

// ---------------------------
// AI Functions
// ---------------------------
async function getAIJobRoles(skills) {
    const prompt = `
        User skills: ${skills.join(", ")}

        Suggest top 3 matching job roles.  
        Each role must include:
        - "role": short role name  
        - "score": number (0-100)  

        ⚠️ IMPORTANT: Respond ONLY as JSON with this exact format:  

        {
        "roles": [
            { "role": "Backend Developer", "score": 85 },
            { "role": "Database Engineer", "score": 70 },
            { "role": "Full Stack Developer", "score": 65 }
        ]
        }
        `;


  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });


    if (!response.choices || response.choices.length === 0) {
      throw new Error("No choices returned from Backend");
    }

    const parsed = JSON.parse(response.choices[0].message.content);

    if (Array.isArray(parsed)) return parsed;
    if (parsed.roles && Array.isArray(parsed.roles)) return parsed.roles;
    if (parsed.jobs && Array.isArray(parsed.jobs)) return parsed.jobs;

    console.warn("⚠️ Unexpected AI format:", parsed);
    return [];
  } catch (err) {
    console.error("❌ AI Job Roles Error:", err.message);

    if (err.response && err.response.error) {
      console.error("OpenAI error details:", err.response.error);
    }

    res.status(500).json({
      error: "AI service unavailable. Please try again later."
    });

    return [];
  }
}

async function getAIDetailsForJob(roleName) {
  const prompt = `
Provide details for the job role: "${roleName}".
Include jobrole, description, tech stack, resume keywords, project ideas, roadmap link.
Respond as JSON.
`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      response_format: { type: "json_object" },
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (err) {
    console.error("❌ AI job details error for", roleName, err.message);
    return null;
  }
}

// ---------------------------
// Routes
// ---------------------------
app.post("/recommend", async (req, res) => {
  try {
    const { skills } = req.body;
    if (!skills || !Array.isArray(skills) || skills.length === 0) {
      return res.status(400).json({ error: "Skills array required" });
    }

    const aiRoles = await getAIJobRoles(skills);

    console.log("Ai roles:", aiRoles);
   

    const finalJobs = [];

    for (const r of aiRoles) {
      const roleName = typeof r === "string" ? r : r.role;
      const score = r.score || null;

        const [rows] = await db.query(
          "SELECT * FROM job_roles WHERE TRIM(LOWER(role_name)) = TRIM(LOWER(?))",
          [role_name]
        );


      if (rows.length > 0) {
        const row = rows[0];
        finalJobs.push({
          role: row.role_name,
          score,
          preview: row.description.substring(0, 130) + "...",
          projectIdeas: safeParse(row.project_ideas).map((p) =>
            typeof p === "string" ? p : p.title
          ),
        });
      } else {
        const jobDetails = await getAIDetailsForJob(roleName);
        console.log("Ai jobDetails:", jobDetails);
         console.log("AI jobDetails:", jobDetails.jobRole , jobDetails.jobrole, jobDetails.role);
        if (jobDetails) {
          await db.query(
            "INSERT INTO job_roles (role_name, description, tech_stack, resume_keywords, project_ideas, roadmap_link) VALUES (?, ?, ?, ?, ?, ?)",
            [
              jobDetails.jobRole || jobDetails.jobrole,
              jobDetails.description,
              JSON.stringify(jobDetails.techStack),
              JSON.stringify(jobDetails.resumeKeywords),
              JSON.stringify(jobDetails.projectIdeas),
              jobDetails.roadmapLink,
            ]
          );

          finalJobs.push({
            role: jobDetails.role,
            score,
            preview: jobDetails.description.substring(0, 130) + "...",
            projectIdeas: jobDetails.projectIdeas.map((p) =>
              typeof p === "string" ? p : p.title
            ),
          });
        }
      }
    }

    res.json(finalJobs);
  } catch (err) {
    console.error("❌ Error in /recommend:", err.message);
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.get("/job/:role", async (req, res) => {
  try {
    const role = decodeURIComponent(req.params.role).toLowerCase();
    const [rows] = await db.query(
      "SELECT * FROM job_roles WHERE LOWER(role_name) = ?",
      [role.toLowerCase()]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Job not found" });
    }

    const job = rows[0];
    res.json({
      role: job.role_name,
      description: job.description,
      techStack: safeParse(job.tech_stack),
      resumeKeywords: safeParse(job.resume_keywords),
      projectIdeas: safeParse(job.project_ideas),
      roadmapLink: job.roadmap_link,
    });
  } catch (err) {
    console.error("❌ Error in /job/:role:", err.message);
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.get("/jobs", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM job_roles ORDER BY role_name ASC");

    const jobs = rows.map((row) => ({
      role: row.role_name,
      preview: row.description.substring(0, 120) + "...",
      projectIdeas: safeParse(row.project_ideas).map((p) =>
        typeof p === "string" ? p : p.title
      ),
      roadmapLink: row.roadmap_link || null,
    }));

    res.json(jobs);
  } catch (err) {
    console.error("❌ Error in /jobs:", err.message);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// ---------------------------
// Global Error + 404
// ---------------------------
app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, next) => {
  console.error("❌ Server error:", err.message);
  res.status(500).json({ error: "Server error" });
});

// ---------------------------
// Start server
// ---------------------------
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
