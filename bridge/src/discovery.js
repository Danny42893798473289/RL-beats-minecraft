import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_INVENTED, PRIMITIVES } from "./skills.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = process.env.INVENTED_SKILLS_PATH
  ?? path.resolve(__dirname, "../../runtime/invented_skills.json");

export class SkillInventor {
  constructor(filePath = DEFAULT_PATH) {
    this.filePath = filePath;
    this.skills = [];
    this.episodeTrace = [];
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.skills = [];
        return;
      }
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      this.skills = Array.isArray(raw.skills) ? raw.skills.slice(0, MAX_INVENTED) : [];
    } catch {
      this.skills = [];
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(
      this.filePath,
      JSON.stringify({ updatedAt: new Date().toISOString(), skills: this.skills }, null, 2)
    );
  }

  resetEpisode() {
    this.episodeTrace = [];
  }

  record(action, result) {
    if (Number(action) >= PRIMITIVES.length) return;
    this.episodeTrace.push({
      action: Number(action),
      name: PRIMITIVES[action],
      ok: Boolean(result?.ok)
    });
    if (this.episodeTrace.length > 64) {
      this.episodeTrace = this.episodeTrace.slice(-64);
    }
  }

  /**
   * When a milestone flips true, invent a reusable skill from the recent primitive trace.
   */
  maybeInvent(before, after) {
    const unlocked = Object.keys(after).filter((key) => !before[key] && after[key]);
    const invented = [];
    for (const milestone of unlocked) {
      const skill = this._inventForMilestone(milestone);
      if (skill) invented.push(skill);
    }
    return invented;
  }

  _inventForMilestone(milestone) {
    if (this.skills.some((skill) => skill.milestone === milestone)) {
      return null;
    }
    if (this.skills.length >= MAX_INVENTED) return null;

    const sequence = this.episodeTrace
      .filter((step) => step.ok)
      .slice(-12)
      .map((step) => step.action);
    if (sequence.length < 2) return null;

    const signature = `${milestone}:${sequence.join(",")}`;
    if (this.skills.some((skill) => skill.signature === signature)) return null;

    const skill = {
      name: `INVENTED_${milestone}_${this.skills.length}`,
      milestone,
      sequence,
      signature,
      createdAt: new Date().toISOString(),
      uses: 0
    };
    this.skills.push(skill);
    this.save();
    console.log(`Invented skill ${skill.name} sequence=${sequence.map((i) => PRIMITIVES[i]).join("→")}`);
    return skill;
  }

  list() {
    return this.skills;
  }
}
