import { useState, useCallback } from "react";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Paste your keys here before running
const CONFIG = {
  SPOTIFY_CLIENT_ID: "YOUR_SPOTIFY_CLIENT_ID",
  TICKETMASTER_API_KEY: "YOUR_TICKETMASTER_API_KEY",
  BANDSINTOWN_APP_ID: "YOUR_BANDSINTOWN_APP_ID", // can be any string you choose
  SPOTIFY_REDIRECT_URI: window.location.origin + window.location.pathname,
};

const SPOTIFY_SCOPES = "user-library-read";
const TM_LA_DMA = "324"; // Ticketmaster DMA for Los Angeles

// ─── SPOTIFY AUTH ─────────────────────────────────────────────────────────────
function getSpotifyToken() {
  const hash = window.location.hash;
  if (hash) {
    const params = new URLSearchParams(hash.replace("#", "?"));
    const token = params.get("access_token");
    if (token) {
      window.history.replaceState({}, "", window.location.pathname);
      return token;
    }
  }
  return sessionStorage.getItem("spotify_token");
}

function launchSpotifyAuth() {
  const params = new URLSearchParams({
    client_id: CONFIG.SPOTIFY_CLIENT_ID,
    response_type: "token",
    redirect_uri: CONFIG.SPOTIFY_REDIRECT_URI,
    scope: SPOTIFY_SCOPES,
    show_dialog: "false",
  });
  window.location.href = `https://accounts.spotify.com/authorize?${params}`;
}

// ─── API HELPERS ──────────────────────────────────────────────────────────────
async function fetchAllSavedArtists(token) {
  let artists = new Map();
  let url = "https://api.spotify.com/v1/me/tracks?limit=50&offset=0";
  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error("Spotify fetch failed");
    const data = await res.json();
    for (const item of data.items) {
      for (const artist of item.track.artists) {
        if (!artists.has(artist.id)) {
          artists.set(artist.id, { id: artist.id, name: artist.name });
        }
      }
    }
    url = data.next;
  }
  return [...artists.values()];
}

async function fetchTicketmasterShows(artistName) {
  try {
    const params = new URLSearchParams({
      apikey: CONFIG.TICKETMASTER_API_KEY,
      keyword: artistName,
      dmaId: TM_LA_DMA,
      classificationName: "music",
      size: "5",
      sort: "date,asc",
    });
    const res = await fetch(
      `https://app.ticketmaster.com/discovery/v2/events.json?${params}`
    );
    if (!res.ok) return [];
    const data = await res.json();
    const events = data._embedded?.events || [];
    return events.map((e) => ({
      source: "Ticketmaster",
      artist: artistName,
      name: e.name,
      date: e.dates?.start?.localDate || "TBD",
      time: e.dates?.start?.localTime || "",
      venue: e._embedded?.venues?.[0]?.name || "Unknown Venue",
      city: e._embedded?.venues?.[0]?.city?.name || "LA",
      url: e.url,
    }));
  } catch {
    return [];
  }
}

async function fetchBandsintownShows(artistName) {
  try {
    const encoded = encodeURIComponent(artistName);
    const res = await fetch(
      `https://rest.bandsintown.com/artists/${encoded}/events?app_id=${CONFIG.BANDSINTOWN_APP_ID}&date=upcoming`
    );
    if (!res.ok) return [];
    const events = await res.json();
    if (!Array.isArray(events)) return [];
    const laEvents = events.filter((e) => {
      const region = (e.venue?.region || "").toLowerCase();
      const city = (e.venue?.city || "").toLowerCase();
      return (
        region === "ca" &&
        (city.includes("los angeles") ||
          city.includes("hollywood") ||
          city.includes("west hollywood") ||
          city.includes("culver city") ||
          city.includes("santa monica") ||
          city.includes("burbank") ||
          city.includes("anaheim") ||
          city.includes("pomona") ||
          city.includes("pasadena") ||
          city.includes("inglewood") ||
          city.includes("long beach"))
      );
    });
    return laEvents.map((e) => ({
      source: "Bandsintown",
      artist: artistName,
      name: `${artistName} at ${e.venue?.name}`,
      date: e.datetime?.split("T")[0] || "TBD",
      time: e.datetime?.split("T")[1]?.slice(0, 5) || "",
      venue: e.venue?.name || "Unknown Venue",
      city: e.venue?.city || "LA",
      url: e.url || e.offers?.[0]?.url || "#",
    }));
  } catch {
    return [];
  }
}

function dedupeShows(shows) {
  const seen = new Set();
  return shows.filter((s) => {
    const key = `${s.artist.toLowerCase()}|${s.date}|${s.venue.toLowerCase().slice(0, 20)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatDate(dateStr) {
  if (!dateStr || dateStr === "TBD") return "TBD";
  try {
    const d = new Date(dateStr + "T12:00:00");
    return d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [token, setToken] = useState(() => {
    const t = getSpotifyToken();
    if (t) sessionStorage.setItem("spotify_token", t);
    return t;
  });
  const [stage, setStage] = useState("idle"); // idle | loading | done | error
  const [progress, setProgress] = useState({ current: 0, total: 0, label: "" });
  const [shows, setShows] = useState([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [sortBy, setSortBy] = useState("date");
  const [filterText, setFilterText] = useState("");

  const keysConfigured =
    CONFIG.SPOTIFY_CLIENT_ID !== "YOUR_SPOTIFY_CLIENT_ID" &&
    CONFIG.TICKETMASTER_API_KEY !== "YOUR_TICKETMASTER_API_KEY" &&
    CONFIG.BANDSINTOWN_APP_ID !== "YOUR_BANDSINTOWN_APP_ID";

  const handleConnect = () => {
    if (!keysConfigured) return;
    launchSpotifyAuth();
  };

  const handleSearch = useCallback(async () => {
    if (!token) return;
    setStage("loading");
    setShows([]);
    setErrorMsg("");

    try {
      setProgress({ current: 0, total: 0, label: "Reading your Spotify library…" });
      const artists = await fetchAllSavedArtists(token);
      setProgress({ current: 0, total: artists.length, label: `Found ${artists.length} artists. Checking concerts…` });

      const allShows = [];
      const BATCH = 5;
      for (let i = 0; i < artists.length; i += BATCH) {
        const batch = artists.slice(i, i + BATCH);
        const results = await Promise.all(
          batch.flatMap((a) => [
            fetchTicketmasterShows(a.name),
            fetchBandsintownShows(a.name),
          ])
        );
        results.forEach((r) => allShows.push(...r));
        setProgress({
          current: Math.min(i + BATCH, artists.length),
          total: artists.length,
          label: `Checking concerts… (${Math.min(i + BATCH, artists.length)} / ${artists.length})`,
        });
        // small delay to respect rate limits
        await new Promise((r) => setTimeout(r, 200));
      }

      const deduped = dedupeShows(allShows).sort(
        (a, b) => new Date(a.date) - new Date(b.date)
      );
      setShows(deduped);
      setStage("done");
    } catch (e) {
      setErrorMsg(e.message || "Something went wrong.");
      setStage("error");
    }
  }, [token]);

  const sorted = [...shows]
    .filter(
      (s) =>
        !filterText ||
        s.artist.toLowerCase().includes(filterText.toLowerCase()) ||
        s.venue.toLowerCase().includes(filterText.toLowerCase())
    )
    .sort((a, b) => {
      if (sortBy === "date") return new Date(a.date) - new Date(b.date);
      if (sortBy === "artist") return a.artist.localeCompare(b.artist);
      if (sortBy === "venue") return a.venue.localeCompare(b.venue);
      return 0;
    });

  const pct =
    progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : 0;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Mono:ital,wght@0,300;0,400;1,300&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
          --bg: #0a0a0a;
          --surface: #111111;
          --border: #222222;
          --accent: #e8ff47;
          --accent2: #ff4747;
          --text: #f0f0f0;
          --muted: #555555;
          --tm: #026cdf;
          --bit: #00a0c9;
        }

        body { background: var(--bg); color: var(--text); font-family: 'DM Mono', monospace; }

        .app {
          min-height: 100vh;
          padding: 0 0 80px 0;
        }

        /* HEADER */
        .header {
          padding: 48px 40px 32px;
          border-bottom: 1px solid var(--border);
          position: relative;
          overflow: hidden;
        }
        .header::before {
          content: 'LA';
          position: absolute;
          right: -20px;
          top: -40px;
          font-family: 'Bebas Neue', sans-serif;
          font-size: 280px;
          color: #ffffff06;
          pointer-events: none;
          line-height: 1;
        }
        .eyebrow {
          font-size: 10px;
          letter-spacing: 0.3em;
          text-transform: uppercase;
          color: var(--accent);
          margin-bottom: 12px;
        }
        .title {
          font-family: 'Bebas Neue', sans-serif;
          font-size: clamp(48px, 8vw, 96px);
          line-height: 0.95;
          letter-spacing: 0.02em;
          color: var(--text);
        }
        .title span { color: var(--accent); }
        .subtitle {
          margin-top: 16px;
          font-size: 11px;
          color: var(--muted);
          letter-spacing: 0.1em;
          max-width: 480px;
          line-height: 1.8;
        }

        /* SETUP PANEL */
        .setup-panel {
          margin: 40px 40px 0;
          border: 1px solid var(--border);
          background: var(--surface);
          padding: 28px 32px;
        }
        .setup-title {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 22px;
          letter-spacing: 0.05em;
          color: var(--accent);
          margin-bottom: 18px;
        }
        .setup-step {
          display: flex;
          gap: 16px;
          margin-bottom: 14px;
          align-items: flex-start;
        }
        .step-num {
          font-size: 9px;
          letter-spacing: 0.2em;
          color: var(--accent);
          background: #1a1a00;
          border: 1px solid var(--accent);
          padding: 3px 6px;
          flex-shrink: 0;
          margin-top: 1px;
        }
        .step-text {
          font-size: 11px;
          line-height: 1.8;
          color: #aaa;
        }
        .step-text a {
          color: var(--accent);
          text-decoration: none;
        }
        .step-text a:hover { text-decoration: underline; }
        .step-text code {
          background: #1c1c1c;
          padding: 1px 6px;
          font-size: 10px;
          color: #ccc;
          border: 1px solid #333;
        }
        .config-warning {
          margin-top: 20px;
          padding: 12px 16px;
          background: #1a0000;
          border-left: 3px solid var(--accent2);
          font-size: 10px;
          color: #ff8080;
          letter-spacing: 0.05em;
          line-height: 1.8;
        }

        /* ACTIONS */
        .actions {
          margin: 32px 40px 0;
          display: flex;
          gap: 12px;
          align-items: center;
          flex-wrap: wrap;
        }
        .btn {
          font-family: 'DM Mono', monospace;
          font-size: 11px;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          padding: 14px 28px;
          border: 1px solid;
          cursor: pointer;
          transition: all 0.15s;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          text-decoration: none;
        }
        .btn-primary {
          background: var(--accent);
          color: #000;
          border-color: var(--accent);
          font-weight: 500;
        }
        .btn-primary:hover:not(:disabled) {
          background: #fff;
          border-color: #fff;
        }
        .btn-primary:disabled {
          opacity: 0.35;
          cursor: not-allowed;
        }
        .btn-secondary {
          background: transparent;
          color: var(--text);
          border-color: var(--border);
        }
        .btn-secondary:hover {
          border-color: var(--text);
        }
        .btn-spotify {
          background: #1db954;
          color: #000;
          border-color: #1db954;
          font-weight: 500;
        }
        .btn-spotify:hover:not(:disabled) {
          background: #1ed760;
          border-color: #1ed760;
        }
        .btn-spotify:disabled { opacity: 0.35; cursor: not-allowed; }
        .connected-badge {
          font-size: 10px;
          color: #1db954;
          letter-spacing: 0.1em;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .dot { width: 6px; height: 6px; border-radius: 50%; background: #1db954; }

        /* PROGRESS */
        .progress-wrap {
          margin: 32px 40px 0;
        }
        .progress-label {
          font-size: 10px;
          letter-spacing: 0.15em;
          color: var(--muted);
          margin-bottom: 10px;
        }
        .progress-bar-bg {
          height: 2px;
          background: var(--border);
          width: 100%;
        }
        .progress-bar-fill {
          height: 2px;
          background: var(--accent);
          transition: width 0.3s ease;
        }
        .progress-pct {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 48px;
          color: var(--accent);
          margin-top: 8px;
          line-height: 1;
        }

        /* RESULTS HEADER */
        .results-header {
          margin: 40px 40px 0;
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 16px;
          padding-bottom: 16px;
          border-bottom: 1px solid var(--border);
        }
        .results-count {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 36px;
          letter-spacing: 0.03em;
        }
        .results-count span { color: var(--accent); }
        .controls {
          display: flex;
          gap: 12px;
          align-items: center;
          flex-wrap: wrap;
        }
        .filter-input {
          background: var(--surface);
          border: 1px solid var(--border);
          color: var(--text);
          font-family: 'DM Mono', monospace;
          font-size: 11px;
          padding: 8px 14px;
          width: 200px;
          outline: none;
          letter-spacing: 0.05em;
        }
        .filter-input::placeholder { color: var(--muted); }
        .filter-input:focus { border-color: var(--accent); }
        .sort-group {
          display: flex;
          gap: 0;
        }
        .sort-btn {
          background: transparent;
          border: 1px solid var(--border);
          border-right: none;
          color: var(--muted);
          font-family: 'DM Mono', monospace;
          font-size: 9px;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          padding: 8px 12px;
          cursor: pointer;
          transition: all 0.15s;
        }
        .sort-btn:last-child { border-right: 1px solid var(--border); }
        .sort-btn.active { background: var(--accent); color: #000; border-color: var(--accent); }
        .sort-btn:not(.active):hover { color: var(--text); border-color: #444; }

        /* SHOW LIST */
        .shows-list {
          margin: 0 40px;
        }
        .show-row {
          display: grid;
          grid-template-columns: 140px 1fr 1fr auto;
          gap: 0;
          border-bottom: 1px solid var(--border);
          align-items: center;
          transition: background 0.1s;
        }
        .show-row:hover { background: #141414; }
        .show-cell {
          padding: 16px 20px;
          font-size: 11px;
          line-height: 1.5;
        }
        .show-cell:first-child { padding-left: 0; }
        .show-date {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 14px;
          letter-spacing: 0.05em;
          color: var(--text);
          line-height: 1.2;
        }
        .show-time {
          font-size: 9px;
          color: var(--muted);
          letter-spacing: 0.1em;
          margin-top: 2px;
        }
        .show-artist {
          font-size: 13px;
          font-weight: 400;
          color: var(--text);
          letter-spacing: 0.03em;
        }
        .show-venue {
          color: var(--muted);
          font-size: 10px;
          letter-spacing: 0.08em;
          margin-top: 3px;
        }
        .show-venue-name {
          font-size: 11px;
          color: #888;
        }
        .show-city {
          font-size: 9px;
          color: var(--muted);
          letter-spacing: 0.1em;
          margin-top: 2px;
          text-transform: uppercase;
        }
        .source-badge {
          font-size: 8px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          padding: 3px 7px;
          border: 1px solid;
        }
        .source-tm { color: var(--tm); border-color: var(--tm); }
        .source-bit { color: var(--bit); border-color: var(--bit); }
        .ticket-link {
          font-size: 9px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--accent);
          text-decoration: none;
          display: block;
          margin-top: 6px;
        }
        .ticket-link:hover { text-decoration: underline; }

        /* EMPTY / ERROR */
        .empty-state {
          margin: 60px 40px;
          text-align: center;
          color: var(--muted);
        }
        .empty-icon {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 80px;
          color: #1a1a1a;
          line-height: 1;
        }
        .empty-msg {
          font-size: 11px;
          letter-spacing: 0.1em;
          margin-top: 12px;
        }
        .error-msg {
          margin: 32px 40px;
          padding: 16px 20px;
          background: #1a0000;
          border-left: 3px solid var(--accent2);
          font-size: 11px;
          color: #ff8080;
          letter-spacing: 0.05em;
        }

        /* COLUMN HEADERS */
        .col-headers {
          display: grid;
          grid-template-columns: 140px 1fr 1fr auto;
          gap: 0;
          margin: 0 40px;
          padding: 10px 0;
          border-bottom: 1px solid var(--border);
        }
        .col-hdr {
          padding: 0 20px;
          font-size: 8px;
          letter-spacing: 0.2em;
          text-transform: uppercase;
          color: var(--muted);
        }
        .col-hdr:first-child { padding-left: 0; }

        @media (max-width: 700px) {
          .header { padding: 32px 20px 24px; }
          .setup-panel, .actions, .progress-wrap,
          .results-header, .shows-list, .col-headers, .error-msg, .empty-state {
            margin-left: 20px;
            margin-right: 20px;
          }
          .show-row, .col-headers {
            grid-template-columns: 100px 1fr auto;
          }
          .show-row > .show-cell:nth-child(3) { display: none; }
          .col-hdr:nth-child(3) { display: none; }
        }
      `}</style>

      <div className="app">
        {/* HEADER */}
        <div className="header">
          <div className="eyebrow">Concert Finder — Los Angeles</div>
          <div className="title">
            Your Artists.<br />
            <span>Live in LA.</span>
          </div>
          <div className="subtitle">
            Connects to your Spotify saved songs, extracts every artist,
            and cross-references Ticketmaster + Bandsintown for upcoming
            shows in and around Los Angeles.
          </div>
        </div>

        {/* SETUP INSTRUCTIONS */}
        {!keysConfigured && (
          <div className="setup-panel">
            <div className="setup-title">// Setup Required</div>
            <div className="setup-step">
              <div className="step-num">01</div>
              <div className="step-text">
                <strong style={{color:"#ddd"}}>Spotify</strong> — Create an app at{" "}
                <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">
                  developer.spotify.com/dashboard
                </a>. Add <code>{window.location.origin + window.location.pathname}</code> as a Redirect URI.
                Copy the <strong>Client ID</strong> into <code>SPOTIFY_CLIENT_ID</code>.
              </div>
            </div>
            <div className="setup-step">
              <div className="step-num">02</div>
              <div className="step-text">
                <strong style={{color:"#ddd"}}>Ticketmaster</strong> — Get a free API key at{" "}
                <a href="https://developer.ticketmaster.com" target="_blank" rel="noreferrer">
                  developer.ticketmaster.com
                </a> (instant approval). Paste into <code>TICKETMASTER_API_KEY</code>.
              </div>
            </div>
            <div className="setup-step">
              <div className="step-num">03</div>
              <div className="step-text">
                <strong style={{color:"#ddd"}}>Bandsintown</strong> — No approval needed. Just set{" "}
                <code>BANDSINTOWN_APP_ID</code> to any short string that identifies your app (e.g. <code>my-concert-app</code>).
              </div>
            </div>
            <div className="setup-step">
              <div className="step-num">04</div>
              <div className="step-text">
                Open this file, find the <code>CONFIG</code> object at the top, and replace the placeholder values with your real keys.
              </div>
            </div>
            <div className="config-warning">
              ⚠ API keys are not yet configured — replace the placeholder values in the CONFIG object at the top of the file before connecting.
            </div>
          </div>
        )}

        {/* ACTIONS */}
        <div className="actions">
          {!token ? (
            <button
              className="btn btn-spotify"
              onClick={handleConnect}
              disabled={!keysConfigured}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
              </svg>
              Connect Spotify
            </button>
          ) : (
            <>
              <span className="connected-badge">
                <span className="dot" /> Spotify connected
              </span>
              <button
                className="btn btn-primary"
                onClick={handleSearch}
                disabled={stage === "loading"}
              >
                {stage === "loading" ? "Scanning…" : "Find LA Shows"}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  sessionStorage.removeItem("spotify_token");
                  setToken(null);
                  setStage("idle");
                  setShows([]);
                }}
              >
                Disconnect
              </button>
            </>
          )}
        </div>

        {/* PROGRESS */}
        {stage === "loading" && (
          <div className="progress-wrap">
            <div className="progress-label">{progress.label}</div>
            <div className="progress-bar-bg">
              <div
                className="progress-bar-fill"
                style={{ width: `${pct}%` }}
              />
            </div>
            {progress.total > 0 && (
              <div className="progress-pct">{pct}%</div>
            )}
          </div>
        )}

        {/* ERROR */}
        {stage === "error" && (
          <div className="error-msg">⚠ {errorMsg}</div>
        )}

        {/* RESULTS */}
        {stage === "done" && (
          <>
            <div className="results-header">
              <div className="results-count">
                <span>{sorted.length}</span> upcoming shows
                {filterText && ` matching "${filterText}"`}
              </div>
              <div className="controls">
                <input
                  className="filter-input"
                  placeholder="Filter by artist or venue…"
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                />
                <div className="sort-group">
                  {["date", "artist", "venue"].map((s) => (
                    <button
                      key={s}
                      className={`sort-btn ${sortBy === s ? "active" : ""}`}
                      onClick={() => setSortBy(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {sorted.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">∅</div>
                <div className="empty-msg">
                  No upcoming LA shows found for your artists.
                </div>
              </div>
            ) : (
              <>
                <div className="col-headers">
                  <div className="col-hdr">Date</div>
                  <div className="col-hdr">Artist</div>
                  <div className="col-hdr">Venue</div>
                  <div className="col-hdr">Source</div>
                </div>
                <div className="shows-list">
                  {sorted.map((show, i) => (
                    <div className="show-row" key={i}>
                      <div className="show-cell">
                        <div className="show-date">{formatDate(show.date)}</div>
                        {show.time && (
                          <div className="show-time">{show.time}</div>
                        )}
                      </div>
                      <div className="show-cell">
                        <div className="show-artist">{show.artist}</div>
                        <div className="show-venue">{show.name !== `${show.artist} at ${show.venue}` ? show.name : ""}</div>
                      </div>
                      <div className="show-cell">
                        <div className="show-venue-name">{show.venue}</div>
                        <div className="show-city">{show.city}, CA</div>
                        {show.url && show.url !== "#" && (
                          <a
                            href={show.url}
                            target="_blank"
                            rel="noreferrer"
                            className="ticket-link"
                          >
                            Tickets →
                          </a>
                        )}
                      </div>
                      <div className="show-cell">
                        <span
                          className={`source-badge ${
                            show.source === "Ticketmaster"
                              ? "source-tm"
                              : "source-bit"
                          }`}
                        >
                          {show.source === "Ticketmaster" ? "TM" : "BIT"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
