"use strict";
const C = require("./common.js");
const fs = C.fs;
const path = C.path;
const cp = C.cp;
const SRC = C.canvasSrc;
const ACC = C.lineWith("polite acknowledgement");
const ST12 = C.lineWith("Speaking frequency");
const FORGED = SRC.replace(ACC + "\n\n", "").replace(ST12, "Speaking frequency is what decides uptake. [stated]");
const out = [];
function line(id, cls, decision, effect, desc) { out.push(id + " | " + cls + " | " + decision + " | " + effect + " | " + desc); }

let r = C.makeProject();
let v = C.runHook(r, "Write", { file_path: path.join(r, "research", "canvas.md"), content: FORGED });
line("R0", "control", v.decision, v.decision === "DENY" ? "reason: " + String(v.reason).slice(0, 80) : "NO DENY", "Write the forged canvas to the canonical path");

r = C.makeProject();
v = C.runHook(r, "Write", { file_path: path.join(r, "research", "CANVAS.md"), content: FORGED });
let eff = "-";
if (v.decision === "ALLOW") {
  fs.writeFileSync(path.join(r, "research", "CANVAS.md"), FORGED);
  const after = C.readOr(C.canvasFile(r));
  eff = "canvas.md now " + (after === FORGED ? "IS the forged text (CANVAS OVERWRITTEN)" : "unchanged") + "; research/ contains " + JSON.stringify(fs.readdirSync(path.join(r, "research")));
}
line("R1", "path", v.decision, eff, "P6 rerun: Write the forged canvas to research/CANVAS.md (case variation)");

r = C.makeProject();
v = C.runHook(r, "MultiEdit", { file_path: C.canvasFile(r), edits: [{ old_string: ACC, new_string: "" }] });
line("R2", "tool", v.decision, v.decision === "ALLOW" ? "guard produced no output for tool_name=MultiEdit" : String(v.reason).slice(0, 80), "T1 rerun: MultiEdit deleting the accepted statement");

r = C.makeProject();
const cmd = "cat research/canvas.md; rm research/canvas.md";
v = C.runHook(r, "Bash", { command: cmd });
eff = "-";
if (v.decision === "ALLOW") {
  cp.spawnSync("/bin/sh", ["-c", cmd], { cwd: r, encoding: "utf8" });
  eff = "after executing it, research/canvas.md exists: " + fs.existsSync(C.canvasFile(r));
}
line("R3", "shell", v.decision, eff, "B1 rerun: cat research/canvas.md; rm research/canvas.md");

process.stdout.write("SQ-21 RECONFIRMATION at main 5257023 -- one representative hole per class completed in the earlier pass.\n\n" + out.join("\n") + "\n");
