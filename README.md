# Arcade Boss Battle (React + PixiJS)

Studio-style 8-bit livestream game that fetches SPL token holders by mint, runs a dramatic
elimination against a giant boss, and crowns ONE winner with a copyable address. Includes
a leaderboard panel you can wire to your backend.

## Deploy (No Local Setup)
1) Push this folder to a GitHub repo.
2) On Netlify or Vercel:
   - Build command: `npm run build`
   - Output directory: `dist`
3) Open your live URL, paste:
   - Token Mint (contract)
   - CORS-enabled RPC (Helius/Shyft recommended)
   - Click **Fetch Holders** → **Start Battle**

## Notes
- For 3k+ holders, prefer an indexer. Replace `fetchHoldersViaIndexer`.
- RNG is seeded using `getLatestBlockhash` for fairness.
- Swap in your own pixel-art sprites by editing `SPRITES` in `src/App.jsx`.
