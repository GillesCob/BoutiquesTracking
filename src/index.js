import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const PORT = process.env.PORT || 3003;
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "tracking.db");
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://www.gillescobigo.com";
// Requise pour DELETE /track/:slug (remise a zero du tracking d'un prospect a l'envoi du mail de
// prospection, cf Projets/Boutiques/workflow-cc.md). Le reste de l'API reste sans auth (donnees
// non sensibles), mais une suppression est destructive et le slug est public (visible dans l'URL
// du prospect) : n'importe qui le connaissant pourrait sinon vider les donnees d'un autre.
const ADMIN_KEY = process.env.ADMIN_KEY;

// Tier 1 uniquement (cf Projets/Boutiques/workflow-cc.md) : juste "quelle etape du funnel chaque
// prospect a atteinte", pas d'attribution fine par CTA ni de temps passe sur la page.
const ALLOWED_STEPS = new Set(["p1", "p2", "page-finale", "modale-numero", "visite-guidee"]);

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL,
    step TEXT NOT NULL,
    ts TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_slug ON events(slug);
`);

const insertEvent = db.prepare("INSERT INTO events (slug, step, ts) VALUES (?, ?, ?)");
const allEvents = db.prepare("SELECT slug, step, ts FROM events ORDER BY ts ASC");
const eventsForSlug = db.prepare("SELECT step, ts FROM events WHERE slug = ? ORDER BY ts ASC");
const deleteEventsForSlug = db.prepare("DELETE FROM events WHERE slug = ?");

const app = express();
// Autorise le vrai domaine (beacon envoye par les pages prospect en prod/mockup) et l'origine
// "null" (page ouverte en file://, cas du Dashboard Boutiques/suivi.html en local, pas de
// credentials/cookie ici donc pas de risque a l'ouvrir a la lecture depuis un fichier local).
// www ET sans www toujours autorises ensemble (corrige le 20/08) : ALLOWED_ORIGIN valait
// "https://gillescobigo.com" (sans www) alors que gillescobigo.com redirige (308) vers
// www.gillescobigo.com, seule origine que le navigateur envoie jamais reellement en prod -
// aucun beacon de prospect reel n'a donc jamais passe le CORS depuis la mise en prod du
// tracking, silencieusement (trackFunnelBeacon avale l'erreur cote front). www toujours inclus
// en plus de ALLOWED_ORIGIN, quelle que soit sa valeur, pour ne plus jamais reproduire cet ecart
// si le domaine canonique change un jour.
const WWW_VARIANT = ALLOWED_ORIGIN.startsWith("https://www.")
  ? ALLOWED_ORIGIN.replace("https://www.", "https://")
  : ALLOWED_ORIGIN.replace("https://", "https://www.");
app.use(cors({ origin: [ALLOWED_ORIGIN, WWW_VARIANT, "null"] }));
app.use(express.json());

// Route obligatoire sur tout backend (cf ~/.claude/CLAUDE.md).
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Beacon fire-and-forget appele par les pages du funnel. Ne doit jamais faire echouer le
// fonctionnement de la page appelante (cote frontend : appel non bloquant, erreurs avalees) ;
// cote backend, on reste strict sur le payload pour ne jamais stocker n'importe quoi.
app.post("/track", (req, res) => {
  const { slug, step } = req.body || {};
  if (typeof slug !== "string" || !slug.trim() || !ALLOWED_STEPS.has(step)) {
    return res.status(400).json({ error: "invalid payload" });
  }
  insertEvent.run(slug.trim().slice(0, 100), step, new Date().toISOString());
  res.status(204).end();
});

// Lecture pour le Dashboard (Projets/Boutiques/suivi.html). Pas d'auth pour l'instant (donnees
// non sensibles - juste "quel prospect a vu quelle etape a quel moment" -, endpoint non liste
// nulle part publiquement, cf lessons deja actees sur ce type de compromis ailleurs dans le
// vault). A durcir (cle partagee en query param minimum) si le besoin se confirme.
app.get("/track", (_req, res) => {
  const grouped = {};
  for (const row of allEvents.all()) {
    (grouped[row.slug] ||= []).push({ step: row.step, ts: row.ts });
  }
  res.json(grouped);
});

app.get("/track/:slug", (req, res) => {
  res.json(eventsForSlug.all(req.params.slug));
});

// Remise a zero du tracking d'un prospect (cf Projets/Boutiques/workflow-cc.md, "remise a zero a
// l'envoi du mail") : les visites de Gilles lui-meme (relecture/verification, avant l'envoi)
// n'ont pas vocation a se melanger aux vraies visites du prospect une fois le mail parti. Protege
// par ADMIN_KEY (destructif, slug public donc devinable). Si ADMIN_KEY n'est pas configuree,
// l'endpoint refuse tout appel plutot que d'accepter une suppression non protegee par defaut.
app.delete("/track/:slug", (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const { changes } = deleteEventsForSlug.run(req.params.slug);
  res.json({ deleted: changes });
});

app.listen(PORT, () => {
  console.log(`boutiques-tracking listening on :${PORT}`);
});
