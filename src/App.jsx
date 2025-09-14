
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Application, Assets, Container, Sprite, Graphics } from "pixi.js";
import * as web3 from "@solana/web3.js";

/**
 * Arcade Boss Battle — Livestream-Ready (React + PixiJS)
 * Paste a mint + CORS-enabled RPC, fetch holders, press Start Battle.
 * - Scales to thousands of holders (represents as dots; zooms for finale)
 * - Winner banner with Copy button
 * - Leaderboard stubs for tokens bought/given + USD equivalents
 */

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com"; // Use a CORS-enabled RPC in production

const CONFIG = {
  arena: { width: 1280, height: 720 },
  fighters: {
    totalVisibleDots: 500,
    radius: 2,
    color: 0xffffff,
  },
  phases: {
    eliminationsPerBurst: { min: 25, max: 120 },
    msBetweenBursts: 1200,
    finalCount: 10,
  },
  boss: { spriteScale: 4 },
};

const SPRITES = {
  background: "https://i.imgur.com/9t5p1Gf.png",
  boss: "https://i.imgur.com/5b1e9v4.png",
  fxExplosion: "https://i.imgur.com/BjKdbU9.png",
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sample(arr, n) {
  if (n >= arr.length) return [...arr];
  const out = [];
  const used = new Set();
  while (out.length < n) {
    const idx = Math.floor(Math.random() * arr.length);
    if (!used.has(idx)) { used.add(idx); out.push(arr[idx]); }
  }
  return out;
}

async function seedRngFromRecentBlockhash(connection) {
  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const seedStr = blockhash + ":" + lastValidBlockHeight;
    let seed = 0;
    for (let i = 0; i < seedStr.length; i++) seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
    let state = seed;
    Math.random = function () {
      state = (1664525 * state + 1013904223) >>> 0;
      return (state & 0xffffffff) / 0x100000000;
    };
  } catch (e) {
    console.warn("Failed to seed RNG from blockhash; using default Math.random", e);
  }
}

async function fetchHoldersViaRPC(mint, rpcUrl) {
  const connection = new web3.Connection(rpcUrl, "confirmed");
  await seedRngFromRecentBlockhash(connection);

  const TOKEN_PROGRAM_ID = new web3.PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const mintPk = new web3.PublicKey(mint);

  const accounts = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
    filters: [
      { dataSize: 165 },
      { memcmp: { offset: 0, bytes: mintPk.toBase58() } },
    ],
  });

  const holders = [];
  for (const acc of accounts) {
    const data = acc.account.data;
    const ownerBytes = data.slice(32, 64);
    const amountBytes = data.slice(64, 72);
    const owner = new web3.PublicKey(ownerBytes).toBase58();
    let amount = 0n;
    for (let i = 0; i < 8; i++) amount += BigInt(amountBytes[i]) << (8n * BigInt(i));
    if (amount > 0n) holders.push({ owner, amount });
  }

  const map = new Map();
  for (const h of holders) {
    const prev = map.get(h.owner) || 0n;
    map.set(h.owner, prev + h.amount);
  }
  return Array.from(map.entries()).map(([owner, amount]) => ({ owner, amount }));
}

async function fetchHoldersViaIndexer(mint, _apiKey) {
  // Swap in your indexer (Helius/Shyft/etc.) to speed this up at scale.
  return null;
}

async function fetchHolders(mint, rpcUrl, indexerKey) {
  const viaIndexer = await fetchHoldersViaIndexer(mint, indexerKey);
  if (viaIndexer && viaIndexer.length) return viaIndexer;
  return await fetchHoldersViaRPC(mint, rpcUrl);
}

function usePixiApp(width, height) {
  const viewRef = useRef(null);
  const appRef = useRef(null);

  useEffect(() => {
    const app = new Application({
      width,
      height,
      antialias: false,
      background: "#0a0a0a",
      resolution: 1,
      autoDensity: true,
    });
    appRef.current = app;
    (async () => {
      await Assets.init();
      await Promise.all(Object.values(SPRITES).map((url) => Assets.load(url)));
      if (viewRef.current) viewRef.current.appendChild(app.view);
    })();
    return () => { app.destroy(true, { children: true, texture: true, baseTexture: true }); };
  }, [width, height]);

  return { viewRef, appRef };
}

function crtOverlay(w, h) {
  const g = new Graphics();
  g.beginFill(0xffffff, 0.05);
  for (let y = 0; y < h; y += 3) g.drawRect(0, y, w, 1);
  g.endFill();
  return g;
}

function randomInArena(W, H) {
  const pad = 30;
  return {
    x: pad + Math.random() * (W - pad * 2),
    y: pad + Math.random() * (H - pad * 2),
  };
}

export default function ArcadeBossBattle() {
  const [rpc, setRpc] = useState(DEFAULT_RPC);
  const [mint, setMint] = useState("");
  const [loading, setLoading] = useState(false);
  const [holders, setHolders] = useState([]);
  const [visibleHorde, setVisibleHorde] = useState([]);
  const [phase, setPhase] = useState("idle"); // idle|ready|fighting|finale|winner
  const [winner, setWinner] = useState(null);
  const [stats, setStats] = useState({ tokensBought: 0n, tokensGiven: 0n, usdBought: 0, usdGiven: 0 });
  const [indexerKey, setIndexerKey] = useState("");
  const [useDemo, setUseDemo] = useState(false);

  const W = CONFIG.arena.width;
  const H = CONFIG.arena.height;
  const { viewRef, appRef } = usePixiApp(W, H);

  useEffect(() => {
    const app = appRef.current;
    if (!app) return;
    const stage = app.stage;
    stage.removeChildren();

    const bg = Sprite.from(SPRITES.background);
    bg.width = W;
    bg.height = H;
    stage.addChild(bg);

    const boss = Sprite.from(SPRITES.boss);
    boss.anchor.set(0.5);
    boss.scale.set(CONFIG.boss.spriteScale);
    boss.x = W / 2;
    boss.y = H / 2 - 40;
    stage.addChild(boss);

    const horde = new Container();
    stage.addChild(horde);

    const scan = crtOverlay(W, H);
    stage.addChild(scan);

    stage.horde = horde;
    stage.boss = boss;
  }, [appRef, W, H, phase]);

  useEffect(() => {
    const app = appRef.current; if (!app) return;
    const horde = app.stage.horde; if (!horde) return;
    horde.removeChildren();
    for (const w of visibleHorde) {
      const dot = new Graphics();
      dot.beginFill(CONFIG.fighters.color);
      dot.drawRect(0, 0, CONFIG.fighters.radius, CONFIG.fighters.radius);
      dot.endFill();
      const p = randomInArena(W, H);
      dot.x = p.x; dot.y = p.y;
      dot.alpha = 0.9;
      dot.wallet = w.owner;
      horde.addChild(dot);
    }
  }, [visibleHorde]);

  async function handleFetch() {
    setLoading(true);
  }

    setWinner(null); setPhase("idle");
    try {
      let data;
      if (useDemo) {
        const demo = Array.from({ length: 3000 }, (_, i) => ({
          owner: `DemoWallet_${i.toString().padStart(4, "0")}`,
          amount: BigInt(1000 + Math.floor(Math.random()*100000))
        }));
        data = demo;
      } else {
        data = await fetchHolders(mint.trim(), rpc.trim(), indexerKey.trim());
      }
      if (!data || !data.length) throw new Error("No holders found. Check mint or use a CORS‑enabled RPC/indexer.");
      setHolders(data);
      setVisibleHorde(sample(data, CONFIG.fighters.totalVisibleDots));
      setPhase("ready");
    } catch (e) {
      alert(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleStart() {
    if (!holders.length) return;
    setPhase("fighting");

    const app = appRef.current; if (!app) return;
    const horde = app.stage.horde; if (!horde) return;

    let roster = [...holders];

    while (roster.length > CONFIG.phases.finalCount) {
      const burst = Math.floor(CONFIG.phases.eliminationsPerBurst.min + Math.random() * (CONFIG.phases.eliminationsPerBurst.max - CONFIG.phases.eliminationsPerBurst.min + 1));
      const n = Math.min(burst, roster.length - CONFIG.phases.finalCount);

      for (let i = 0; i < n; i++) {
        const idx = Math.floor(Math.random() * roster.length);
        const [removed] = roster.splice(idx, 1);
        const dot = horde.children.find(c => c.wallet === removed.owner);
        if (dot) {
          const fx = Sprite.from(SPRITES.fxExplosion);
          fx.x = dot.x; fx.y = dot.y; fx.anchor.set(0.5); fx.scale.set(0.75 + Math.random()*0.5);
          horde.addChild(fx);
          dot.destroy();
          setTimeout(() => fx.destroy(), 350);
        }
      }
      if (Math.random() < 0.6) setVisibleHorde(sample(roster, CONFIG.fighters.totalVisibleDots));
      await sleep(CONFIG.phases.msBetweenBursts);
    }

    setPhase("finale");
    setVisibleHorde(sample(roster, Math.min(CONFIG.fighters.totalVisibleDots, roster.length)));

    while (roster.length > 1) {
      const idx = Math.floor(Math.random() * roster.length);
      const [removed] = roster.splice(idx, 1);
      const app2 = appRef.current; if (!app2) break;
      const dot = app2.stage.horde.children.find(c => c.wallet === removed.owner);
      if (dot) {
        const fx = Sprite.from(SPRITES.fxExplosion);
        fx.x = dot.x; fx.y = dot.y; fx.anchor.set(0.5); fx.scale.set(1.2);
        app2.stage.horde.addChild(fx);
        dot.destroy();
        setTimeout(() => fx.destroy(), 450);
      }
      await sleep(600);
    }

    const champ = roster[0];
    setWinner(champ);
    setPhase("winner");
  }

  function copyWinner() {
    if (winner?.owner) navigator.clipboard.writeText(winner.owner);
  }

  useEffect(() => {
    const id = setInterval(() => {
      setStats((s) => ({
        tokensBought: s.tokensBought + 12345n,
        tokensGiven: s.tokensGiven + 6789n,
        usdBought: s.usdBought + 12.34,
        usdGiven: s.usdGiven + 6.78,
      }));
    }, 1500);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="container">
      <h1>Arcade Boss Battle</h1>
      <div className="grid grid-4">
        <div className="panel col">
          <strong>Winner Engine</strong>
          <label>Token Mint (Contract)</label>
          <input className="input" value={mint} onChange={e=>setMint(e.target.value)} placeholder="Enter SPL token mint address" />
          <label>RPC URL (CORS-enabled)</label>
          <input className="input" value={rpc} onChange={e=>setRpc(e.target.value)} />
          <label>Indexer API Key (optional)</label>
          <input className="input" value={indexerKey} onChange={e=>setIndexerKey(e.target.value)} placeholder="If configured in code" />
          <label className="row"><input type="checkbox" checked={useDemo} onChange={e=>setUseDemo(e.target.checked)} /> <span>Use demo holders (3,000)</span></label>
          <div className="row">
            <button className="btn alt" disabled={loading} onClick={handleFetch}>{loading ? "Fetching…" : "Fetch Holders"}</button>
            <button className="btn" disabled={(phase!=="ready" && phase!=="idle") || !holders.length} onClick={handleStart}>Start Battle</button>
            <button className="btn gray" onClick={()=>{setPhase("idle"); setWinner(null); setVisibleHorde([]);}}>Reset</button>
          </div>
          <div style={{opacity:.8,fontSize:12,marginTop:6}}>
            Status: <span className="mono">{phase.toUpperCase()}</span> • Holders: <span className="mono">{holders.length || 0}</span>
          </div>
          {winner && (
            <div className="panel" style={{marginTop:8}}>
              <div style={{opacity:.7,fontSize:12}}>Winner</div>
              <div className="mono" style={{wordBreak:"break-all", color:"#34d399"}}>{winner.owner}</div>
              <div className="row" style={{marginTop:8}}>
                <button className="btn alt" onClick={copyWinner}>Copy Address</button>
              </div>
            </div>
          )}
        </div>
        <div className="panel">
          <div style={{borderRadius:12, overflow:"hidden", border:"1px solid rgba(120,120,140,.35)"}}>
            <div ref={viewRef} style={{ width: CONFIG.arena.width + "px", height: CONFIG.arena.height + "px", imageRendering: "pixelated" }} />
          </div>
          {phase === "winner" && winner && (
            <div className="panel" style={{marginTop:12, background:"linear-gradient(90deg,#065f46,#6d28d9)"}}>
              <div style={{fontSize:20, fontWeight:800}}>🏆 Champion Crowned!</div>
              <div className="mono" style={{wordBreak:"break-all"}}>{winner.owner}</div>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-3" style={{marginTop:16}}>
        <div className="panel">
          <div style={{fontWeight:700, marginBottom:8}}>Leaderboard (stub)</div>
          <div style={{opacity:.8, fontSize:14, marginBottom:10}}>Hook this to your backend that records cycles.</div>
          <ul className="mono" style={{fontSize:14, lineHeight:1.8}}>
            <li>Tokens Bought: <span style={{color:"#34d399"}}>{stats.tokensBought.toString()}</span></li>
            <li>USD Bought: <span style={{color:"#34d399"}}>${stats.usdBought.toFixed(2)}</span></li>
            <li>Tokens Given: <span style={{color:"#f472b6"}}>{stats.tokensGiven.toString()}</span></li>
            <li>USD Given: <span style={{color:"#f472b6"}}>${stats.usdGiven.toFixed(2)}</span></li>
          </ul>
        </div>
        <div className="panel" style={{gridColumn:'span 1 / -1'}}>
          <div style={{fontWeight:700, marginBottom:8}}>Integration Notes</div>
          <ol style={{opacity:.9, fontSize:14, lineHeight:1.7, paddingLeft:18}}>
            <li><b>Holders:</b> Prefer an indexer (Helius/Shyft/etc.). Replace <code>fetchHoldersViaIndexer</code>. Ensure CORS.</li>
            <li><b>Fairness:</b> RNG seeded from <code>getLatestBlockhash</code>. For VRF/commit‑reveal, anchor to a specific slot.</li>
            <li><b>Leaderboard:</b> Point to a backend endpoint returning totals + USD. Replace the demo ticker.</li>
            <li><b>Stream:</b> Add SFX (whooshes, explosions) with <code>new Audio().play()</code> at burst timings.</li>
            <li><b>Assets:</b> Swap pixel art background/boss/explosion with your own sprites.</li>
            <li><b>Final 10:</b> Optional: label truncated addresses and add zoom for drama.</li>
          </ol>
        </div>
      </div>
    </div>
  );
}
