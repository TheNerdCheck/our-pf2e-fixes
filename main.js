/**
 * Our PF2e Fixes - Shed Spirit (Witch feat: Spirit Familiar)
 *
 * Usage (script macro, run as the player):
 *   game.modules.get("our-pf2e-fixes").api.shedSpirit();
 *
 * Select the familiar's (or the witch's) token, target the enemy, run the macro.
 *
 * Flow:
 *   1. Level -> damage dice (6d6, +2d6 at level 9 and every 2 levels after).
 *   2. Spell DC from the witch's spellcasting.
 *   3. GM gets a prompt and rolls the Will save (socketlib).
 *   4. A whispered GM card with the damage button is posted; the GM rolls and applies it.
 *   5. The macro watches the enemy's HP, takes the damage actually dealt,
 *      and asks for the ally who gets half of it as healing.
 */

const MODULE_ID = "our-pf2e-fixes";

// Index = PF2e degreeOfSuccess: 0 crit. failure, 1 failure, 2 success, 3 crit. success
const DEGREE = ["Critical Failure", "Failure", "Success", "Critical Success"];
const APPLY_HINT = [
  "double damage (x2 button)",
  "full damage",
  "half damage (1/2 button)",
  "no damage",
];

const RANGE_ENEMY_FT = 20; // familiar -> enemy
const RANGE_ALLY_FT = 30; // enemy -> ally

let socket;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** HP + temp HP, so damage soaked up by temp HP still counts as damage dealt. */
const totalHP = (actor) => {
  const hp = actor.system.attributes.hp;
  return hp.value + (hp.temp ?? 0);
};

/** 6d6 at level 8, +2d6 at level 9 and every 2 levels after. */
function shedSpiritDice(level) {
  return 6 + 2 * Math.max(0, Math.floor((level - 7) / 2));
}

/**
 * The witch's own spell DC, as { dc, source } or null.
 * actor.spellcasting also contains scrolls, wands, staves and rituals, so prefer the
 * prepared entry (the witch's class entry) and only fall back to the highest DC of all entries.
 */
function getSpellDC(actor) {
  const entries = (actor.spellcasting?.contents ?? []).filter((e) => Number.isFinite(e.statistic?.dc?.value));
  const prepared = entries.filter((e) => e.category === "prepared");
  const pool = prepared.length ? prepared : entries;
  let best = null;
  for (const entry of pool) {
    if (!best || entry.statistic.dc.value > best.statistic.dc.value) best = entry;
  }
  if (best) return { dc: best.statistic.dc.value, source: best.name };

  const fallback = actor.system.attributes?.spellDC?.value;
  return Number.isFinite(fallback) ? { dc: fallback, source: "spellDC" } : null;
}

/** Distance in feet between two tokens, or null if it cannot be measured. */
function distanceFt(a, b) {
  try {
    const d = a.distanceTo(b);
    return Number.isFinite(d) ? d : null;
  } catch (err) {
    return null;
  }
}

function warnIfOutOfRange(from, to, maxFt, what) {
  if (!from || !to) return;
  const d = distanceFt(from, to);
  if (d !== null && d > maxFt) {
    ui.notifications.warn(`${what}: about ${Math.round(d)} ft away (limit ${maxFt} ft).`);
  }
}

/* ------------------------------------------------------------------ */
/* GM-side handlers (executed on the GM's client via socketlib)        */
/* ------------------------------------------------------------------ */

/** Ask the GM to roll the Will save. Returns degreeOfSuccess (0-3) or null. */
async function rollWillSave({ tokenUuid, dc, dcSource, casterName }) {
  const tokenDoc = await fromUuid(tokenUuid);
  const actor = tokenDoc?.actor;
  if (!actor) return null;

  const go = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Shed Spirit" },
    content:
      `<p>${esc(casterName)}'s familiar uses Shed Spirit on <strong>${esc(tokenDoc.name)}</strong>.</p>` +
      `<p>Roll a basic Will save against DC <strong>${dc}</strong> (${esc(dcSource ?? "spell DC")})?</p>`,
    yes: { label: "Roll Will save" },
    no: { label: "Cancel" },
    rejectClose: false,
  });
  if (!go) return null;

  const roll = await actor.saves.will.roll({
    dc: { value: dc },
    extraRollOptions: ["damaging-effect", "spirit", "action:shed-spirit"],
  });
  return roll?.degreeOfSuccess ?? null;
}

/** Heal the ally on the GM's client (players may not own the ally). */
async function applyHealing({ tokenUuid, amount }) {
  const tokenDoc = await fromUuid(tokenUuid);
  const actor = tokenDoc?.actor;
  if (!actor || !(amount > 0)) return 0;

  const before = actor.system.attributes.hp.value;
  const max = actor.system.attributes.hp.max;

  // Preferred: the system's own pipeline (handles dying/unconscious etc.).
  try {
    await actor.applyDamage({ damage: -amount, token: tokenDoc });
  } catch (err) {
    console.warn(`${MODULE_ID} | applyDamage with negative value failed, using fallback`, err);
  }

  // Fallback: plain HP update if nothing happened.
  if (actor.system.attributes.hp.value <= before && before < max) {
    await actor.update({ "system.attributes.hp.value": Math.min(max, before + amount) });
  }
  return actor.system.attributes.hp.value - before;
}

/* ------------------------------------------------------------------ */
/* Player-side steps                                                   */
/* ------------------------------------------------------------------ */

/**
 * Watch the target's HP until the GM has applied damage, then return
 * the damage actually dealt (HP + temp HP lost). 0 if cancelled / timeout.
 */
async function waitForDamage(targetToken) {
  const start = totalHP(targetToken.actor);
  let cancelled = false;

  const dialog = new foundry.applications.api.DialogV2({
    window: { title: "Shed Spirit" },
    content: `<p>Waiting for the GM to roll the damage and apply it to <strong>${esc(targetToken.name)}</strong>...</p>`,
    buttons: [{ action: "cancel", label: "No damage / cancel", default: true }],
    submit: () => {
      cancelled = true;
    },
  });
  dialog.render({ force: true });

  const deadline = Date.now() + 15 * 60 * 1000;
  let dealt = 0;
  while (!cancelled && Date.now() < deadline) {
    await sleep(500);
    if (totalHP(targetToken.actor) < start) {
      await sleep(1500); // let multi-step applications settle
      dealt = start - totalHP(targetToken.actor);
      break;
    }
  }
  try {
    await dialog.close();
  } catch (err) {
    /* already closed */
  }
  return dealt;
}

/** Let the player target the ally and confirm. Returns a token UUID or null. */
async function chooseAlly(amount) {
  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: "Shed Spirit - healing" },
    content:
      `<p>The spirit restores <strong>${amount} HP</strong>.</p>` +
      `<p>Target the ally (within ${RANGE_ALLY_FT} ft of the enemy), then press Heal.</p>`,
    buttons: [
      {
        action: "heal",
        label: "Heal targeted ally",
        default: true,
        callback: () => game.user.targets.first()?.document.uuid ?? "none",
      },
      { action: "skip", label: "Skip healing" },
    ],
    rejectClose: false,
  });
  return typeof choice === "string" && choice.includes(".") ? choice : null;
}

/* ------------------------------------------------------------------ */
/* Main entry point                                                    */
/* ------------------------------------------------------------------ */

async function shedSpirit() {
  if (!socket) return ui.notifications.error("Our PF2e Fixes: socketlib is not ready.");

  const sel = canvas.tokens.controlled[0];
  const selActor = sel?.actor;
  if (!selActor) return ui.notifications.warn("Select the familiar's or the witch's token first.");

  const witch = selActor.type === "familiar" ? selActor.master : selActor;
  if (!witch) return ui.notifications.warn("Could not find the witch (the familiar has no master).");

  const familiarToken =
    selActor.type === "familiar"
      ? sel
      : canvas.tokens.placeables.find((t) => t.actor?.type === "familiar" && t.actor.master?.id === witch.id);

  const target = game.user.targets.first();
  if (!target) return ui.notifications.warn("Target an enemy first.");

  const level = witch.level;
  if (level < 8) ui.notifications.warn("The witch is below level 8; Spirit Familiar needs level 8.");
  const dice = shedSpiritDice(level);

  const dcInfo = getSpellDC(witch);
  if (!dcInfo) return ui.notifications.error("Could not read the witch's spell DC.");
  const dc = dcInfo.dc;
  console.log(`${MODULE_ID} | Shed Spirit: level ${level}, ${dice}d6, DC ${dc} (from "${dcInfo.source}")`);

  warnIfOutOfRange(familiarToken, target, RANGE_ENEMY_FT, "Enemy");

  // 1) GM rolls the basic Will save
  let degree;
  try {
    degree = await socket.executeAsGM("rollWillSave", {
      tokenUuid: target.document.uuid,
      dc,
      dcSource: dcInfo.source,
      casterName: witch.name,
    });
  } catch (err) {
    console.error(err);
    return ui.notifications.error("Shed Spirit: no GM available to roll the save.");
  }
  if (degree === null || degree === undefined) return ui.notifications.info("Shed Spirit cancelled.");

  if (degree === 3) {
    return ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ token: (familiarToken ?? sel).document }),
      content:
        `<p><strong>Shed Spirit</strong> on ${esc(target.name)}: Will save <em>${DEGREE[3]}</em> (DC ${dc}). ` +
        `No damage, so no healing.</p>`,
    });
  }

  // 2) Whispered GM card with the damage button (standard PF2e damage card on click)
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ token: (familiarToken ?? sel).document }),
    whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id),
    content:
      `<p><strong>Shed Spirit</strong> on ${esc(target.name)}: Will save <em>${DEGREE[degree]}</em> (DC ${dc}).</p>` +
      `<p>Roll the damage, then apply <strong>${APPLY_HINT[degree]}</strong>:</p>` +
      `<p>@Damage[(${dice}d6)[spirit]]{${dice}d6 spirit damage}</p>`,
  });

  // 3) Read the damage actually dealt
  const dealt = await waitForDamage(target);
  if (dealt <= 0) return ui.notifications.info("Shed Spirit: no damage dealt, so no healing.");

  const healing = Math.floor(dealt / 2);
  if (healing < 1) return ui.notifications.info("Shed Spirit: healing rounds down to 0.");

  // 4) Pick the ally and heal
  const allyUuid = await chooseAlly(healing);
  if (!allyUuid) return ui.notifications.info("Shed Spirit: healing skipped.");

  const allyToken = game.user.targets.first();
  warnIfOutOfRange(target, allyToken, RANGE_ALLY_FT, "Ally");

  const healed = await socket.executeAsGM("applyHealing", { tokenUuid: allyUuid, amount: healing });

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ token: (familiarToken ?? sel).document }),
    content:
      `<p><strong>Shed Spirit</strong>: ${esc(target.name)} took ${dealt} damage; ` +
      `${esc(allyToken?.name ?? "the ally")} is restored for ${healed} HP (half of the damage dealt).</p>`,
  });
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

Hooks.once("socketlib.ready", () => {
  socket = socketlib.registerModule(MODULE_ID);
  socket.register("rollWillSave", rollWillSave);
  socket.register("applyHealing", applyHealing);
});

Hooks.once("ready", () => {
  game.modules.get(MODULE_ID).api = { shedSpirit };
});
