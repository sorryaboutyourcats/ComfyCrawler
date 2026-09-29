    // ==========================================
    // THE TRAILERS - ComfyCrawler in 30 seconds, at <site>/trailer and <site>/trailer2
    // ==========================================
    // Injected by game.js's boot block when TRAILER_MODE is on, and loaded by nothing else. A
    // classic script, like game.js, so it reaches game.js's top-level functions and bindings
    // directly - the engine plays the trailer, this file only directs it.
    //
    // The trailers share this one director. The address picks which (/trailer, /trailer2,
    // /trailer11, or ?trailer / ?trailer=2): its cast is <name>.json, and that json's "script"
    // picks the shot list below - SCRIPTS.v1 or SCRIPTS.v2. A json can instead "extends" another
    // and change only a few keys: trailer11.json is trailer 1 with "strafe" on, which adds the
    // hero's side-steps to its fights (see strafeV1). A json with "phone" (trailer12m.json) is not
    // a trailer of its own: it shows the one it names inside a phone-sized frame, loaded with
    // ?phone, which makes that page lay itself out and play as it would on a touch screen. Each is cut to its own music track (the json's
    // music - see tools/trailer_beats.py), 64 beats at about 128 BPM. Every cue is a beat number,
    // and the clock is the audio clock, so the cuts stay on the music even if frames drop.
    //
    // v1 (/trailer) - type anything, get a world:
    //   0-8    the Dungeon Creation Wizard types a real run's four blanks, CREATE, a sped-up load
    //   8-16   the drop: that same dungeon - walk, meet its foe, strike, block, kill
    //   16-32  four other runs, one verb each, captioned with the blank they show off
    //   32-44  the rush: one walk forward while the dungeon under it changes every beat or two
    //   44-48  the music tape-stops; back in the first dungeon, its boss at the end of the hall
    //   48-56  the boss fight, the final blow, that run's ending cutscene
    //   56-64  the title card
    //
    // v2 (/trailer2) - and it fights back:
    //   0-12   cold open: a hero dies (YOU DIED!), Restart Dungeon, and this time sidesteps and wins
    //   12-16  the wizard: one blank typed, Fill-in writes the other three, CREATE
    //   16-28  three fights - a dodge, a pack, a flying train - captioned with the blank
    //   28-36  the monster parade: a different foe materialising on nearly every beat
    //   36-40  tape-stop; the typed dungeon's boss at the end of its hall
    //   40-54  the boss pulls back, weaves, takes aim, charges - sidestepped - and falls; its ending
    //   54-64  the title card
    //
    // Everything is loaded before the first frame (the start screen's bar): each dungeon is
    // entered once, quietly, and kept as a captureWorld() snapshot; each shot's maze is drawn from
    // a fixed seed and kept as a captureMaze(). A cut is then just restoreWorld + restoreMaze.
    // Math.random is seeded too, so the trailer plays the same way every time - it can be recorded.
    //
    // game.js names this file's side of the bargain in its TRAILER_MODE guards: while the trailer
    // runs nothing is written to History, Options or localStorage.

    // Every game.js name this file leans on. tests/test_trailer.py checks each one still exists,
    // so a rename there fails a test instead of silently breaking the trailer.
    const TRAILER_NEEDS = [
      'enterDungeon', 'captureWorld', 'restoreWorld', 'captureMaze', 'restoreMaze',
      'generateAuthentic3DMaze', 'resetCombatForNewDungeon', 'toggleBattleMode', 'battleReady',
      'combatAttack', 'moveForward', 'rotateLeft', 'rotateRight', 'render3D', 'drawMinimap',
      'updateHUD', 'renderDoomFace', 'playSfx', 'sfxContext', 'endingClipSrc', 'paintProgressChunks',
      'dirToAngle', 'isWalkable', 'releaseHeldKeys', 'enemySpeedMul',
      'combatState', 'keysHeld', 'player', 'enemyMarkers', 'visitedTiles', 'passagesList', 'MAP',
      'exitRoom', 'activeMarker', 'endingPhase', 'selectedDifficulty', 'currentThemeName',
      'activeMode', 'dungeonStory', 'currentRunHistoryId', 'crawlRollStartedAt',
      'playerSpriteImg', 'playerFaceImg', 'playerSpriteFrames', 'playerFaceFrames', 'enemyVariantImgs',
      'DIR_VECS', 'DIFFICULTIES', 'ENEMY_VARIANTS', 'INTRO_TOTAL', 'ATTACK_HIT_FRAME',
      'START_STING_GAIN', 'SOUNDS_BASE', 'SERVER_URL', 'SHOWCASE_MODE',
      'appContainer', 'screenSetup', 'screenProgress', 'screenGame', 'screenShowcase',
      'endingVideoEl', 'endingCutscene', 'endingFlash', 'battleModeBadge',
      'btnCreate', 'btnUp', 'btnLeft', 'btnRight', 'btnCombatAttack', 'btnCombatBlock',
      'btnEnterDungeon', 'progHeaderIcon', 'progHeaderText', 'progStatusText', 'progPercentText',
      'progPhaseText', 'progTimer',
      // v2
      'btnRestartDungeon', 'viewportCanvas', 'btnCombatDodgeL', 'btnCombatDodgeR', 'btnFillIn',
      'syncFillInLabel', 'showFloatingCombatText', 'totalMoves',
      'BOSS_BACK_FRAMES', 'BOSS_PAUSE_FRAMES', 'BOSS_WINDUP_FRAMES', 'BOSS_RUSH_FRAMES',
    ];

    (function trailer() {
      'use strict';

      // ---- Seeded randomness -------------------------------------------------------------
      // Every maze, pack colour and enemy roll in the engine goes through Math.random. Seeded,
      // the trailer is the same film on every play; reseeded per shot, one shot's rolls can't
      // shift the next one's.
      function mulberry32(a) {
        return function () {
          a |= 0; a = (a + 0x6D2B79F5) | 0;
          let t = Math.imul(a ^ (a >>> 15), 1 | a);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      }
      let rng = mulberry32(1);
      Math.random = () => rng();
      function seedFrom(text) {
        let h = 2166136261;
        for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
        return h >>> 0;
      }
      function reseed(text) { rng = mulberry32(seedFrom(text)); }

      const $ = (id) => document.getElementById(id);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const log = [];
      window.__trailer = { log, state: 'loading', worlds: null, beats: null };

      // Which trailer this address asks for: /trailer, /trailer2 (or ?trailer, ?trailer=2).
      const TRAILER_NAME = (() => {
        const m = window.location.pathname.match(/\/(trailer\d*m?)\/?(index\.html)?$/i);
        if (m) return m[1].toLowerCase();
        const n = new URLSearchParams(window.location.search).get('trailer') || '';
        return /^\d+$/.test(n) && n !== '1' ? `trailer${n}` : 'trailer';
      })();
      window.__trailer.name = TRAILER_NAME;

      // ---- ?phone: the touch-screen game, on any screen -------------------------------------
      // The phone layout is two kinds of rule: width (max-width: 760px - a phone-sized frame gets
      // those by itself) and touch ((pointer: coarse), (hover: none) - which a desktop never
      // matches, frame or not). So on ?phone every touch rule is rewritten to always apply and
      // every mouse-only one to never, and the page is the one a phone gets: stacked window,
      // one-line blanks, the swipe touchpad and the strafe slider.
      const PHONE = new URLSearchParams(window.location.search).has('phone');
      function forceTouchMedia() {
        const walk = (rules) => {
          for (const r of rules) {
            if (!r.media || !r.cssRules) continue;
            const was = r.media.mediaText;
            const now = was.replace(/\((pointer:\s*coarse|hover:\s*none)\)/g, '(min-width: 0px)')
              .replace(/\((pointer:\s*fine|hover:\s*hover)\)/g, '(max-width: 0px)');
            if (now !== was) r.media.mediaText = now;
            walk(r.cssRules);
          }
        };
        for (const sheet of document.styleSheets) {
          try { walk(sheet.cssRules); } catch (_) { /* a stylesheet from elsewhere - none of ours */ }
        }
      }
      if (PHONE) forceTouchMedia();

      // ---- Look ----------------------------------------------------------------------------
      // Its own few rules, so tailwind.css needs no rebuild for a page players never see.
      const style = document.createElement('style');
      style.textContent = `
        #trailerGate { position: fixed; inset: 0; z-index: 9995; display: flex; align-items: center;
          justify-content: center; background: rgba(0, 40, 40, 0.55); padding: 16px; }
        #trailerGate .tg-box { width: min(420px, 100%); }
        #trailerGate .tg-body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 10px;
          font-size: 13px; color: #0f172a; }
        #trailerGate .tg-bar { height: 18px; padding: 2px; background: #c0c0c0; }
        #trailerGate .tg-fill { height: 100%; width: 0%; background: repeating-linear-gradient(90deg,
          #000080 0 10px, transparent 10px 12px); transition: width 0.2s; }
        #trailerGate .tg-status { font-size: 11px; color: #334155; min-height: 1.3em;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        #trailerGate button { font-weight: bold; padding: 6px 14px; font-size: 14px; align-self: center; }
        #trailerGate button:disabled { opacity: 0.5; }
        #trailerBlocker { position: fixed; inset: 0; z-index: 9990; cursor: none; }
        .trailer-pressed { border-top: 2px solid #808080 !important; border-left: 2px solid #808080 !important;
          border-right: 2px solid #fff !important; border-bottom: 2px solid #fff !important;
          box-shadow: inset 1px 1px #0a0a0a !important; filter: brightness(0.92); }
        #trailerCursor { position: fixed; z-index: 9993; width: 22px; height: 32px; left: 0; top: 0;
          pointer-events: none; display: none; transform-origin: 0 0; }
        #trailerChip { display: none; margin-left: 8px; padding: 0 6px; border-radius: 3px; background: #fde047;
          color: #422006; font-size: 10px; font-weight: 900; letter-spacing: 0.04em; }
        #trailerCaption { position: absolute; left: 50%; bottom: 5%; transform: translateX(-50%); z-index: 25;
          display: none; align-items: baseline; gap: 0.45em; white-space: nowrap; max-width: 94%;
          padding: 0.28em 0.8em 0.34em; background: rgba(250, 249, 245, 0.94); border: 2px solid #94a3b8;
          box-shadow: 0 3px 12px rgba(0, 0, 0, 0.45); color: #0f172a; font-weight: bold; pointer-events: none; }
        #trailerCaption .tc-blank { color: #1e3a8a; border-bottom: 0.12em solid #000; padding: 0 0.3em;
          min-width: 3em; text-align: center; font-size: 1.12em; }
        #trailerEnd { display: none; box-sizing: border-box; padding: 4px; }
        #trailerEnd .te-panel { width: 100%; height: 100%; display: flex; flex-direction: column;
          align-items: center; justify-content: center; gap: 0.5em; background: #faf9f5; color: #0f172a;
          text-align: center; overflow: hidden; }
        #trailerEnd .te-icon { width: 4.2em; height: 4.2em; image-rendering: pixelated; }
        #trailerEnd .te-word { font-size: 3.1em; font-weight: 900; letter-spacing: 0.01em; line-height: 1;
          color: #000080; text-shadow: 0.06em 0.06em 0 #fde047; }
        #trailerEnd .te-tag { font-size: 1.55em; font-weight: bold; color: #1e3a8a; min-height: 1.3em;
          border-bottom: 0.08em solid #000; padding: 0 0.4em; }
        #trailerEnd .te-cta { font-size: 0.95em; font-weight: bold; color: #334155; opacity: 0; transition: opacity 0.35s; }
        #trailerEnd .te-where { font-size: 0.85em; color: #1e3a8a; opacity: 0; transition: opacity 0.35s; }
        #trailerEnd .te-outro { font-size: 1.15em; font-weight: bold; color: #0f172a; margin-top: 0.5em; opacity: 0;
          transition: opacity 0.35s; }
        #trailerEnd .te-outro b { color: #1e3a8a; border-bottom: 0.08em solid #1e3a8a; }
        #trailerEnd .te-buttons { display: flex; gap: 0.6em; margin-top: 0.4em; visibility: hidden; }
        #trailerEnd .te-buttons button { font-size: 0.8em; font-weight: bold; padding: 0.35em 1em; }
        #trailerEnd .te-slam { animation: trailerSlam 0.22s ease-out both; }
        @keyframes trailerSlam { from { transform: scale(1.35); opacity: 0; } to { transform: scale(1); opacity: 1; } }
      `;
      document.head.appendChild(style);

      document.title = TRAILER_NAME === 'trailer' ? 'ComfyCrawler — Trailer'
        : `ComfyCrawler — Trailer ${TRAILER_NAME.slice(7)}`;

      // ---- Data ----------------------------------------------------------------------------
      let cfg = null;
      let beats = [];            // seconds into the track, one per beat (trailer.json music.beats)
      let musicBuf = null;
      let clipUrl = null;        // the ending cutscene the trailer closes on, as a blob URL
      let clip = null;           // { id, segs: [[from, to], ...] } - which run's, which seconds
      const worlds = {};         // id -> { id, title, world, shots: {name: {maze, pose, ...}} }

      // The export writes a trimmed copy beside each trailer dungeon's bundle (see
      // tools/export_showcase.py): trailer_bundle.json is the bundle minus the narration and music
      // the trailer never plays, trailer_walk.json - for a dungeon the rush only walks through -
      // also drops every battle sprite. Roughly half, and a fifth, of the full download.
      function bundleUrl(id, file) {
        if (!SHOWCASE_MODE) return `${SERVER_URL}/api/history_bundle?id=${encodeURIComponent(id)}`;
        return `dungeons/${encodeURIComponent(id)}/${file}`;
      }

      async function fetchBundle(id, walkOnly) {
        let res = await fetch(bundleUrl(id, walkOnly ? 'trailer_walk.json' : 'trailer_bundle.json'));
        if (!res.ok && SHOWCASE_MODE) res = await fetch(bundleUrl(id, 'bundle.json'));
        if (!res.ok) throw new Error(`dungeon ${id} would not load (HTTP ${res.status})`);
        return res.json();
      }

      // ---- Mazes and where the camera stands ----------------------------------------------
      const isExitTile = (x, y) => x === exitRoom.x && y === exitRoom.y;
      const openAt = (x, y) => isWalkable(x, y);

      function sightFrom(x, y, d, cap = 9) {
        const v = DIR_VECS[d];
        let n = 0;
        while (n < cap && openAt(x + v.dx * (n + 1), y + v.dy * (n + 1))) n++;
        return n;
      }

      // Walks `pattern` from every floor tile and facing - F a step, T a turn to whichever side
      // opens onto more corridor - and keeps the pose with the longest view at both ends. A shot
      // asks for the moves it will make, so the camera can never walk into a wall on a beat.
      function findPose(pattern, minAhead) {
        let best = null;
        for (const p of passagesList) {
          if (isExitTile(p.x, p.y)) continue;
          for (let d = 0; d < 4; d++) {
            let x = p.x, y = p.y, dir = d, ok = true;
            const turns = [];
            const path = [{ x, y }];
            for (const tok of pattern) {
              if (tok === 'F') {
                const v = DIR_VECS[dir];
                if (!openAt(x + v.dx, y + v.dy) || isExitTile(x + v.dx, y + v.dy)) { ok = false; break; }
                x += v.dx; y += v.dy;
                path.push({ x, y });
              } else if (tok === 'T') {
                const r = (dir + 1) % 4, l = (dir + 3) % 4;
                const sr = sightFrom(x, y, r), sl = sightFrom(x, y, l);
                if (!sr && !sl) { ok = false; break; }
                turns.push(sr >= sl ? 'R' : 'L');
                dir = sr >= sl ? r : l;
              }
            }
            if (!ok) continue;
            const endSight = sightFrom(x, y, dir);
            if (endSight < minAhead) continue;
            const score = endSight + 0.5 * sightFrom(p.x, p.y, d);
            if (!best || score > best.score) {
              best = { x: p.x, y: p.y, d, turns, path, end: { x, y, d: dir }, endSight, score };
            }
          }
        }
        return best;
      }

      // Tiles within `depth` steps of (x, y), as the minimap's "been here" set - a shot should
      // look like a run in progress, not a hero who arrived this second.
      function revealAround(x, y, depth) {
        const seen = new Set([`${x},${y}`]);
        let frontier = [{ x, y }];
        for (let i = 0; i < depth; i++) {
          const next = [];
          for (const c of frontier) {
            for (const v of DIR_VECS) {
              const nx = c.x + v.dx, ny = c.y + v.dy, k = `${nx},${ny}`;
              if (!seen.has(k) && openAt(nx, ny)) { seen.add(k); next.push({ x: nx, y: ny }); }
            }
          }
          frontier = next;
        }
        visitedTiles.clear();
        seen.forEach((k) => visitedTiles.add(k));
      }

      function marker(x, y, variant) {
        return { x, y, variant, alive: true, phase: 1.3 };
      }

      // One shot's maze, drawn from its own seed until one has the corridor it needs.
      function buildShotMaze(id, name, want) {
        for (let attempt = 0; attempt < 40; attempt++) {
          reseed(`${id}/${name}/${attempt}`);
          generateAuthentic3DMaze(DIFFICULTIES.medium.grids);
          let pose = null;
          let markers = [];
          if (want.boss) {
            // The boss's own hall: two tiles back from it, facing it, stairs beyond.
            const boss = enemyMarkers.find((m) => m.variant === 'boss');
            if (!boss) continue;
            for (let d = 0; d < 4 && !pose; d++) {
              const v = DIR_VECS[d];
              const x1 = boss.x - v.dx, y1 = boss.y - v.dy, x2 = boss.x - 2 * v.dx, y2 = boss.y - 2 * v.dy;
              if (openAt(x1, y1) && openAt(x2, y2)) pose = { x: x2, y: y2, d, turns: [], path: [], end: null };
            }
            if (!pose) continue;
            markers = [marker(boss.x, boss.y, 'boss')];
          } else {
            pose = findPose(want.pattern || '', want.ahead || 0);
            if (!pose) continue;
            if (want.foeOnPath) {
              // A foe standing on the path's last tile: the last step walks into the fight.
              const last = pose.path[pose.path.length - 1];
              markers = [marker(last.x, last.y, want.foeOnPath)];
            } else if (want.foeAhead) {
              // A foe further down the corridor the walk ends facing - seen, never reached.
              const v = DIR_VECS[pose.end.d];
              const fx = pose.end.x + v.dx * want.foeAhead, fy = pose.end.y + v.dy * want.foeAhead;
              if (!openAt(fx, fy)) continue;
              markers = [marker(fx, fy, 'walker')];
            }
          }
          enemyMarkers = markers;
          revealAround(pose.x, pose.y, 10);
          pose.path.forEach((p) => visitedTiles.add(`${p.x},${p.y}`));
          return { maze: captureMaze(), pose };
        }
        throw new Error(`no maze for the ${name} shot of ${id}`);
      }

      // ---- Loading --------------------------------------------------------------------------
      // Every dungeon a trailer visits, in the order it first appears, with the shots it needs
      // mazes for (see each script's cast()). Walk shots ask for one more tile of corridor than
      // they step, so the last step still looks down a hall.
      function castBuilder() {
        const cast = [];
        const add = (id, name, want) => {
          let w = cast.find((c) => c.id === id);
          if (!w) { w = { id, shots: {} }; cast.push(w); }
          w.shots[name] = want;
        };
        return { cast, add };
      }
      const FIGHT_POSE = { pattern: '', ahead: 4 };   // a long hall behind the fighters

      // Beats each v1 rush cut walks for: 2,2,2,2 then 1,1,1,1 - the cuts come twice as fast
      // for the last bar, into the break.
      const RUSH_CUTS = [32, 34, 36, 38, 40, 41, 42, 43];
      const RUSH_STEPS = RUSH_CUTS.map((b, i) => (RUSH_CUTS[i + 1] || 44) - b);

      async function loadConfig() {
        const file = `${TRAILER_NAME}.json`;
        const res = await fetch(file, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`${file} is missing`);
        cfg = await res.json();
        // A variant names the trailer it is built on and overrides only what differs.
        if (cfg.extends) {
          const baseRes = await fetch(`${cfg.extends}.json`, { cache: 'no-cache' });
          if (!baseRes.ok) throw new Error(`${cfg.extends}.json (which ${file} extends) is missing`);
          cfg = { ...(await baseRes.json()), ...cfg };
        }
        const label = cfg.label || TRAILER_NAME.slice(7);
        if (label) {
          document.title = `ComfyCrawler — Trailer ${label}`;
          gate.querySelector('.tg-name').textContent = `ComfyCrawler — 30-second trailer ${label}`;
        }
      }

      async function loadEverything(onProgress) {
        const file = `${TRAILER_NAME}.json`;
        if (!SCRIPTS[cfg.script || 'v1']) throw new Error(`${file} names no known script`);
        beats = (cfg.music && cfg.music.beats) || [];
        if (beats.length < 65) throw new Error(`${file} has no beat grid - run tools/trailer_beats.py --write ${file}`);
        window.__trailer.beats = beats;
        clip = S().clip();

        selectedDifficulty = 'medium';       // fixed maze size and foe health, whatever the viewer picked
        const cast = S().cast();
        const total = cast.length + 2;
        let done = 0;
        const tick = (what) => onProgress(++done / total, what);

        // The track and the clip ride alongside the first bundles.
        const ctx = sfxContext();
        const musicName = String(cfg.music.file || `sounds/${TRAILER_NAME}_music.wav`).split('/').pop();
        const musicJob = fetch(`${SOUNDS_BASE}/${musicName}`)
          .then((r) => { if (!r.ok) throw new Error(`the trailer's music (${musicName}) is missing`); return r.arrayBuffer(); })
          .then((ab) => new Promise((ok, bad) => ctx.decodeAudioData(ab, ok, bad)))
          .then((buf) => { musicBuf = buf; tick('music'); });
        const clipJob = fetch(endingClipSrc(clip.id))
          .then((r) => (r.ok ? r.blob() : null))
          .then((blob) => { if (blob) clipUrl = URL.createObjectURL(blob); tick('ending'); });

        for (const c of cast) {
          onProgress(done / total, `Loading ${cast.indexOf(c) + 1} of ${cast.length}...`);
          // Only in the rush: nothing but walls, floor and a face - no fight is ever cut to.
          const b = await fetchBundle(c.id, Object.keys(c.shots).every((n) => n === 'rush'));
          // What loadHistoryDungeon / armEnterDungeon would have set before enterDungeon.
          reseed(`${c.id}/enter`);
          currentRunHistoryId = c.id;
          dungeonStory = b.story || null;
          currentThemeName = String(b.wall_style || 'Windows 95').replace(/["“”]/g, '');
          activeMode = b.mode || 'v6_krea';
          await enterDungeon(b);
          await decodeAll();
          const shots = {};
          for (const [name, want] of Object.entries(c.shots)) shots[name] = buildShotMaze(c.id, name, want);
          worlds[c.id] = { id: c.id, title: (b.story && b.story.location) || b.wall_style || c.id,
                           world: captureWorld(), shots };
          tick((b.story && b.story.location) || c.id);
          await wait(0);   // let the bar paint
        }
        await Promise.all([musicJob, clipJob]);
        // The clip goes into its <video> now, as the game does at a run's start: its first frame
        // wakes the ending's upscaler (see createClipScaler), native work that stalled the boss
        // fight for a quarter second when it was armed there instead.
        armClip(clip.segs[0][0]);
        window.__trailer.worlds = Object.keys(worlds);
      }

      // Sprites are Images from data URLs, decoded lazily by the browser - the first frame a
      // foe appears on would stall on it. Decoded now, while the bar is still up.
      function decodeAll() {
        const imgs = [playerSpriteImg, playerFaceImg, ...playerSpriteFrames, ...playerFaceFrames];
        Object.values(enemyVariantImgs || {}).forEach((set) => imgs.push(...Object.values(set)));
        return Promise.all(imgs.filter((i) => i && i.decode).map((i) => i.decode().catch(() => {})));
      }

      // ---- The clock -----------------------------------------------------------------------
      let ctx = null;
      let t0 = 0;                // AudioContext time of beat 0
      const PERIOD = () => (beats[64] - beats[0]) / 64;

      // The music's own position is what the viewer hears, which trails currentTime by the
      // output latency - so cues fire against that, and a cut lands with its beat, not ahead of it.
      // currentTime only moves once per audio buffer (10ms or more on some devices), so between
      // moves the frame clock carries it on. Not getOutputTimestamp: headless Chrome hands that
      // back stale, and one run fired the first eleven seconds of cues in a single frame.
      let clockAt = -1, clockPerf = 0, latency = 0;
      function heard() {
        const c = ctx.currentTime, p = performance.now();
        if (c !== clockAt) { clockAt = c; clockPerf = p; }
        return c + Math.min(0.05, (p - clockPerf) / 1000) - latency;
      }
      function rel(b) {
        const i = Math.floor(b), f = b - i;
        if (i + 1 < beats.length) return (beats[i] - beats[0]) + f * (beats[i + 1] - beats[i]);
        return (beats[beats.length - 1] - beats[0]) + (b - (beats.length - 1)) * PERIOD();
      }
      const at = (b) => t0 + rel(b);

      // ---- Music -----------------------------------------------------------------------------
      // One track, cut two ways: a low-pass that holds it back under the opening and opens on the
      // drop, and a tape-stop into silence before the boss - after which a second copy picks the
      // track up exactly where it would have been, so the slam lands on the music's own beat.
      // Where those fall is each script's `music`: { drop, stop, resume, end } in beats.
      const music = { out: null, nodes: [] };
      function startMusic() {
        stopMusicNow();
        const M = S().music;
        music.out = ctx.createGain();
        music.out.gain.value = 0.9;
        music.out.connect(ctx.destination);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.Q.value = 0.8;
        const ga = ctx.createGain();
        const a = ctx.createBufferSource();
        a.buffer = musicBuf;
        a.connect(lp); lp.connect(ga); ga.connect(music.out);
        // A short lead-in before beat 0 - whatever the track plays ahead of its first beat.
        const pre = Math.min(beats[0], 0.3);
        lp.frequency.setValueAtTime(420, at(0) - pre);
        lp.frequency.setValueAtTime(420, at(M.drop - 2));
        lp.frequency.exponentialRampToValueAtTime(2600, at(M.drop - 0.15));
        lp.frequency.setValueAtTime(20000, at(M.drop));
        ga.gain.setValueAtTime(0.8, at(0) - pre);
        ga.gain.setValueAtTime(1, at(M.drop));
        // The tape-stop: the reels run down over one beat, pitch and all.
        a.playbackRate.setValueAtTime(1, at(M.stop));
        a.playbackRate.linearRampToValueAtTime(0.12, at(M.stop + 1));
        ga.gain.setValueAtTime(1, at(M.stop) + 0.05);
        ga.gain.linearRampToValueAtTime(0, at(M.stop + 1));
        a.start(at(0) - pre, beats[0] - pre);
        a.stop(at(M.stop + 1) + 0.05);
        const gb = ctx.createGain();
        const b = ctx.createBufferSource();
        b.buffer = musicBuf;
        b.connect(gb); gb.connect(music.out);
        // The last downbeat: let its hit ring a moment, then stop dead.
        gb.gain.setValueAtTime(1, at(M.end) + 0.2);
        gb.gain.linearRampToValueAtTime(0, at(M.end) + 0.45);
        b.start(at(M.resume), beats[M.resume]);
        b.stop(at(M.end) + 0.5);
        music.nodes = [a, b];
      }
      function stopMusicNow() {
        music.nodes.forEach((n) => { try { n.stop(); } catch (e) { /* already stopped */ } });
        music.nodes = [];
        if (music.out) {
          const out = music.out;
          out.gain.setTargetAtTime(0, ctx.currentTime, 0.04);
          setTimeout(() => { try { out.disconnect(); } catch (e) {} }, 400);
          music.out = null;
        }
      }

      // ---- Screen furniture ----------------------------------------------------------------
      const blocker = document.createElement('div');
      blocker.id = 'trailerBlocker';
      blocker.hidden = true;
      document.body.appendChild(blocker);

      const cursor = document.createElement('img');
      cursor.id = 'trailerCursor';
      cursor.alt = '';
      // The Windows arrow, drawn to the pixel.
      cursor.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="19" viewBox="0 0 12 19" shape-rendering="crispEdges">'
        + '<path d="M0 0v16l4-4 3 7 2-1-3-7h6z" fill="#000"/><path d="M1 2.4v11.2l3-3 3 6.9.3-.2-3-6.9h4.3z" fill="#fff"/></svg>');
      if (PHONE) {
        // A fingertip, not an arrow - centred on what it touches (see moveCursor).
        cursor.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><circle cx="11" cy="11" r="9" '
          + 'fill="rgba(255,255,255,0.55)" stroke="rgba(0,0,0,0.55)" stroke-width="1.5"/></svg>');
        cursor.style.width = '22px';
        cursor.style.height = '22px';
      }
      document.body.appendChild(cursor);

      const chip = document.createElement('span');
      chip.id = 'trailerChip';
      chip.textContent = '⏩ SPED UP';
      progTimer.insertAdjacentElement('afterend', chip);

      const viewportFrame = document.querySelector('.viewport-frame');
      const caption = document.createElement('div');
      caption.id = 'trailerCaption';
      caption.innerHTML = '<span class="tc-lead"></span><span class="tc-blank"></span>';
      viewportFrame.appendChild(caption);
      const capLead = caption.querySelector('.tc-lead');
      const capBlank = caption.querySelector('.tc-blank');

      const endCard = document.createElement('div');
      endCard.id = 'trailerEnd';
      endCard.innerHTML = `
        <div class="te-panel win95-inset">
          <img class="te-icon" src="icon.png" alt="">
          <div class="te-word">ComfyCrawler</div>
          <div class="te-tag"></div>
          <div class="te-cta">▶ Play it free in your browser &nbsp;·&nbsp; 🧩 Make your own in ComfyUI</div>
          <div class="te-where"></div>
          <div class="te-outro"></div>
          <div class="te-buttons">
            <button type="button" class="win95-btn te-replay">↻ Replay</button>
            <button type="button" class="win95-btn te-play">▶ Play ComfyCrawler</button>
          </div>
        </div>`;
      screenGame.insertAdjacentElement('afterend', endCard);
      const endWord = endCard.querySelector('.te-word');
      const endIcon = endCard.querySelector('.te-icon');
      const endTag = endCard.querySelector('.te-tag');
      const endCta = endCard.querySelector('.te-cta');
      const endWhere = endCard.querySelector('.te-where');
      const endButtons = endCard.querySelector('.te-buttons');
      const endOutro = endCard.querySelector('.te-outro');
      const btnReplay = endCard.querySelector('.te-replay');
      const btnPlayGame = endCard.querySelector('.te-play');
      // The game itself: this same folder, without /trailer. <base> (index.html) already points
      // relative URLs there when the address has a trailing slash; without one '.' is the folder.
      const gameUrl = new URL('.', document.baseURI).href;
      // Only a real address is worth printing - a recording made off 127.0.0.1 shouldn't
      // advertise it.
      const host = new URL(gameUrl);
      if (!/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(host.hostname)) {
        endWhere.textContent = (host.host + host.pathname).replace(/\/$/, '');
      }

      function showOnly(screen, mode) {
        [screenSetup, screenProgress, screenGame, screenShowcase, endCard].forEach((s) => {
          if (s) s.classList.toggle('hidden', s !== screen);
        });
        endCard.style.display = screen === endCard ? 'block' : 'none';
        appContainer.className = `win95-box p-1 text-black mode-${mode}`;
      }

      function press(btn, ms = 140) {
        if (!btn) return;
        btn.classList.add('trailer-pressed');
        setTimeout(() => btn.classList.remove('trailer-pressed'), ms);
      }

      // Captions ride the viewport, sized off its width so they read the same in any window.
      let captionTyping = null;
      function showCaption(lead, blank, typeBeats = 0.5) {
        const w = viewportFrame.getBoundingClientRect().width;
        const size = Math.max(12, Math.round(w * 0.036));
        caption.style.fontSize = `${size}px`;
        capLead.textContent = lead;
        capBlank.textContent = blank;
        caption.style.display = 'flex';
        // A long blank ("bright stuffed animal with teeth") shrinks to fit rather than running
        // off the viewport - measured on the whole line before it starts typing.
        const room = w * 0.94;
        if (caption.scrollWidth > room) caption.style.fontSize = `${Math.floor(size * room / caption.scrollWidth)}px`;
        captionTyping = typeBeats > 0 ? { text: blank, from: heard(), dur: rel(typeBeats) - rel(0) } : null;
        capBlank.textContent = captionTyping ? '' : blank;
      }
      function hideCaption() { caption.style.display = 'none'; captionTyping = null; }

      // ---- Things that happen over time rather than on a beat -------------------------------
      // Each is a function of `heard()` and returns false when it is finished.
      let tweens = [];
      function tween(fn) { tweens.push(fn); }

      function typeInto(input, text, fromBeat, toBeat) {
        let shown = -1;
        input.focus({ preventScroll: true });
        tween((now) => {
          const p = Math.min(1, Math.max(0, (now - at(fromBeat)) / (at(toBeat) - at(fromBeat))));
          const n = Math.round(p * text.length);
          if (n !== shown) {
            // A soft key click every few letters - under the music, not over it.
            if (Math.floor(n / 3) !== Math.floor(Math.max(0, shown) / 3) && n > 0) {
              playSfx('button', { gain: 0.14, vary: 0.35 });
            }
            shown = n;
            input.value = text.slice(0, n);
            input.scrollLeft = input.scrollWidth;
          }
          return p < 1;
        });
      }

      function moveCursor(fromEl, toEl, fromBeat, toBeat) {
        const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
        // The fingertip is centred on its spot (16px: half its drawn size); the arrow's tip is its corner.
        const tip = PHONE ? 16 : 0;
        const ax = (PHONE ? a.left + a.width * 0.6 : a.right - 30) - tip, ay = a.top + a.height * 0.7 - tip;
        const bx = b.left + b.width * 0.55 - tip, by = b.top + b.height * 0.55 - tip;
        cursor.style.display = 'block';
        tween((now) => {
          const p = Math.min(1, Math.max(0, (now - at(fromBeat)) / (at(toBeat) - at(fromBeat))));
          const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
          cursor.style.transform = `translate(${ax + (bx - ax) * e}px, ${ay + (by - ay) * e}px) scale(1.5)`;
          return p < 1;
        });
      }

      // The loading bar, sped up: the real stage names a run goes through, a second of them.
      const STAGES = [
        'Designing the set with Qwen3-VL...',
        'Naming the hero and the boss with Qwen3-VL...',
        'Writing the chronicle with Qwen3-VL...',
        'Synthesizing dungeon textures with FLUX.1 [schnell]...',
        'Designing three foes with Qwen3-VL...',
        'Posing your hero with Krea 2...',
        'Painting the HUD portrait...',
        'Foleying the dungeon with Stable Audio 3...',
        'Composing dungeon music with Stable Audio 3...',
        'Filming the ending cutscene with MiniMax H3...',
      ];
      // The run's own opening crawl, as the loading screen shows it - but run at time-lapse speed
      // (a full crawl takes a minute) and started with the title already in view. Built here
      // rather than by startCrawl, which would also start the narrator.
      function timelapseCrawl(story) {
        const crawlText = $('crawlText'), pending = $('crawlPending');
        if (!story || !crawlText) return;
        crawlText.innerHTML = '';
        const title = document.createElement('p');
        title.className = 'crawl-title';
        title.textContent = (story.location || 'THE DUNGEON').toUpperCase();
        crawlText.appendChild(title);
        (story.crawl || []).forEach((text) => {
          const para = document.createElement('p');
          para.textContent = text;
          crawlText.appendChild(para);
        });
        if (pending) pending.style.display = 'none';
        crawlText.style.setProperty('--crawl-duration', '15s');
        // game.js re-times the animation off crawlRollStartedAt when it (re)starts - see its
        // animationstart listener - so "started 2.5s ago" is said there, not in animationDelay.
        crawlRollStartedAt = Date.now() - 2500;
        crawlText.classList.remove('rolling');
        void crawlText.offsetWidth;
        crawlText.classList.add('rolling');
      }

      function zipLoading(fromBeat, toBeat) {
        tween((now) => {
          const p = Math.min(1, Math.max(0, (now - at(fromBeat)) / (at(toBeat) - at(fromBeat))));
          const pct = Math.round(p * 100);
          paintProgressChunks(pct);
          progPercentText.textContent = `${pct}%`;
          progStatusText.textContent = STAGES[Math.min(STAGES.length - 1, Math.floor(p * STAGES.length))];
          progTimer.textContent = `${(p * 240).toFixed(1)}s`;
          return p < 1;
        });
      }

      // ---- The fight, directed ---------------------------------------------------------------
      // A strike is called this far ahead of its beat, so the blade connects on it.
      const STRIKE_LEAD = (ATTACK_HIT_FRAME - 1) / 60;
      const lead = () => combatState.enemies.find((e) => e.hp > 0) || combatState.enemy;
      let tether = false;
      // A foe the trailer kills gets only the health its planned hits take off, so its bar runs
      // down with them instead of jumping from most-full to empty on the last one. Applied the
      // frame a walked-into fight begins (see frame), or straight away for one cut into.
      let pendingHp = 0;
      function planHp(e, hp) { e.maxHp = hp; e.hp = hp; }
      // The most one swing can take off (24-35, the armoured boss 70% of that) - a foe above it
      // survives the hit; one at or under the low end of the roll can't.
      const maxHit = (e) => ((ENEMY_VARIANTS[e.variant] || {}).slow ? 25 : 36);
      const sureKill = (e) => ((ENEMY_VARIANTS[e.variant] || {}).slow ? 16 : 23);

      function freshHero() {
        if (!mortal) combatState.playerHp = Math.max(combatState.playerHp, combatState.playerMaxHp * 0.7);
        combatState.playerStm = combatState.playerMaxStm;
        combatState.exhaustion = 0;
        combatState.exhaustLock = 0;
      }

      // Straight into a fight already under way - the foe named, both sides squared up. `entrance`
      // starts it part-way through the game's own entrance instead (the parade: each foe
      // materialising), in sim ticks of INTRO_TOTAL.
      function fight(variant, hp, entrance) {
        activeMarker = null;
        toggleBattleMode(true, variant);
        combatState.introFrame = entrance === undefined ? INTRO_TOTAL : entrance;
        if (hp) planHp(combatState.enemy, hp);
        freshHero();
      }

      // The swing lands on whichever living foe is nearest the hero - in a pack, that one.
      function strike(kill) {
        if (!combatState.inBattle || combatState.dead) return;
        if (!battleReady()) combatState.introFrame = INTRO_TOTAL;
        freshHero();
        combatState.attackFrame = 0;
        combatState.hurtFrame = 0;
        const living = combatState.enemies.filter((e) => e.hp > 0);
        const near = living.reduce((a, e) => (!a || Math.abs(e.x - combatState.playerX)
          < Math.abs(a.x - combatState.playerX) ? e : a), null);
        for (const e of living) {
          e.blockTimer = 0;
          e.noBlockTimer = Math.max(e.noBlockTimer, 20);
        }
        if (near) {
          if (kill) near.hp = Math.min(near.hp, sureKill(near));
          else if (near.hp <= maxHit(near)) near.hp = Math.min(near.maxHp, maxHit(near) + 1);
        }
        press(btnCombatAttack);
        combatAttack();
      }

      // Strafing, as the Left/Right battle buttons do it - held, with the button shown pressed.
      const strafeSlider = $('strafeSlider');
      function hold(way, on) {
        keysHeld[way] = on;
        const btn = way === 'left' ? btnCombatDodgeL : btnCombatDodgeR;
        if (btn) btn.classList.toggle('trailer-pressed', on);
        // The phone's strafe slider: the knob pushed to that side while held, back to the middle
        // on release - where a thumb holding it would put it.
        if (PHONE && strafeSlider) {
          const knob = strafeSlider.querySelector('.thumb-pad__knob');
          const held = keysHeld.left || keysHeld.right;
          const side = keysHeld.left ? -1 : 1;
          const reach = knob ? Math.max(8, (strafeSlider.clientWidth - knob.offsetWidth) / 2 - 14) : 0;
          if (knob) knob.style.transform = held ? `translateX(${side * reach}px)` : '';
          strafeSlider.dataset.dir = held ? (keysHeld.left ? 'left' : 'right') : '';
          strafeSlider.classList.toggle('is-held', held);
        }
      }

      // A side-step between blows: strafe `way` from beat `from` to beat `to`. The foe keeps to
      // the hero's line (tether, see frame), so it follows them across the arena and the next
      // swing still lands.
      function sway(from, to, way) {
        cue(from, `sway ${way}`, () => { tether = true; hold(way, true); });
        cue(to, 'sway stop', () => hold(way, false));
      }

      // Step out of a blow landing on `beat`, then back in. The foe holds its ground while the
      // hero moves (see `pin` in frame) - a walker stalking after them would otherwise close the
      // gap and turn the dodge into a hit.
      let pin = null;
      function dodge(beat, way) {
        const back = way === 'right' ? 'left' : 'right';
        let tetherWas = false;
        cue(beat - 0.6, `strafe ${way}`, () => {
          const e = lead();
          pin = e ? { e, x: e.x } : null;
          tetherWas = tether;
          tether = false;
          hold(way, true);
        });
        cue(beat - 0.05, 'strafe stop', () => hold(way, false));
        cue(beat + 0.2, 'strafe back', () => { pin = null; hold(back, true); });
        cue(beat + 0.62, 'strafe stop', () => { hold(back, false); tether = tetherWas; });
      }

      // Strafe up to the nearest living foe and hold it where it stands until the swing lands -
      // a pack keeps its formation relative to the hero, so the one being cut down has to stay
      // put while the hero lines up on it (the blade reaches barely past a runt's own width).
      let approach = null;
      function closeIn(beat) {
        cue(beat - 0.45, 'close in', () => {
          const living = combatState.enemies.filter((e) => e.hp > 0);
          const e = living.reduce((a, k) => (!a || Math.abs(k.x - combatState.playerX)
            < Math.abs(a.x - combatState.playerX) ? k : a), null);
          if (!e) return;
          pin = { e, x: e.x };
          approach = { e };
        });
        cue(beat + 0.25, 'let go', () => { pin = null; approach = null; hold('left', false); hold('right', false); });
      }

      // The boss's charge (tickBossCharge in game.js), started on cue and landed on `arrive`:
      // it pulls back, weaves across the back of the arena, takes aim, winds up and rushes. Only
      // the weave is stretched or cut (see frame) so the rush arrives on the beat - the aim, the
      // wind-up and the run-in play at the game's own length, callouts and all.
      let charge = null;
      function startCharge(arrive) {
        const e = lead();
        if (!e || e.variant !== 'boss') return;
        tether = false;
        e.special = 'back';
        e.specialTimer = BOSS_BACK_FRAMES;
        e.blockTimer = 0;
        e.hunting = false;
        e.atkCount = 0;
        e.chargeCount = 0;
        showFloatingCombatText('⚠️ IT PULLS BACK!', 160, 58, '#f87171');
        charge = { e, arrive };
      }

      // The cold open's death: the hero's bars stop being propped up (see frame), and the blow
      // landing on `beat` is the last one.
      let mortal = false;
      function lethalBlow(beat) {
        mortal = true;
        foeBlow(beat, false);
        cue(beat - 0.1, 'doomed', () => { combatState.playerHp = Math.min(combatState.playerHp, 3); });
      }

      // Arms the foe's own clock so its blow lands on `beat`; `guard` raises the hero's shield
      // across it. Called a little after the hero's previous blow has stopped staggering it.
      function foeBlow(beat, guard) {
        const e = lead();
        if (!e || e.hp <= 0) return;
        const c = ENEMY_VARIANTS[e.variant] || ENEMY_VARIANTS.walker;
        const ticks = Math.max(2, Math.round((at(beat) - heard()) * 60));
        if (c.fly) {
          const dive = Math.round(26 / enemySpeedMul(c));
          e.swoop = 'none';
          e.swoopTimer = Math.max(1, ticks - dive);
        } else {
          e.attackTimer = ticks;
          e.special = 'none';
          e.chargeCount = 0;
          e.atkCount = 0;
          e.hunting = false;
        }
        if (guard) {
          cue(beat - 0.5, 'guard up', () => { keysHeld.block = true; btnCombatBlock && btnCombatBlock.classList.add('trailer-pressed'); });
          cue(beat + 0.3, 'guard down', () => { keysHeld.block = false; btnCombatBlock && btnCombatBlock.classList.remove('trailer-pressed'); });
        } else if (!mortal) {
          combatState.playerHp = Math.max(combatState.playerHp, 60);
        }
      }

      // On the phone the moves are shown on the touchpad instead: the arrow for the way just
      // swiped lights, as it does under a real thumb.
      const swipePad = $('swipePad');
      function swipeFlash(dir) {
        if (!PHONE || !swipePad) return;
        swipePad.dataset.dir = dir;
        swipePad.classList.add('is-held');
        setTimeout(() => { swipePad.dataset.dir = ''; swipePad.classList.remove('is-held'); }, 250);
      }
      function step() { press(btnUp); swipeFlash('up'); moveForward(); }
      function turn(way) {
        press(way === 'R' ? btnRight : btnLeft);
        swipeFlash(way === 'R' ? 'right' : 'left');
        (way === 'R' ? rotateRight : rotateLeft)();
      }

      // ---- Cuts ------------------------------------------------------------------------------
      let currentShot = null;
      function cut(id, shotName) {
        const w = worlds[id];
        const s = w.shots[shotName];
        releaseHeldKeys();
        [btnCombatBlock, btnCombatDodgeL, btnCombatDodgeR].forEach((b) => b && b.classList.remove('trailer-pressed'));
        pin = null;
        charge = null;
        approach = null;
        restoreWorld(w.world);
        // Markers are copied: a won fight retires its marker, and a replay must find it standing.
        restoreMaze({ ...s.maze, enemyMarkers: s.maze.enemyMarkers.map((m) => ({ ...m })) });
        resetCombatForNewDungeon();
        toggleBattleMode(false);   // the EXPLORATION badge and D-pad, whatever the last shot left up
        const p = s.pose;
        Object.assign(player, { gridX: p.x, gridY: p.y, posX: p.x + 0.5, posY: p.y + 0.5,
                                dirIndex: p.d, angle: dirToAngle(p.d), isAnimating: false, bumping: false });
        reseed(`${id}/${shotName}/play`);
        currentShot = s;
        if (screenGame.classList.contains('hidden')) showOnly(screenGame, 'game');
        render3D();
        drawMinimap();
        updateHUD();
        renderDoomFace();
        log.push({ cut: `${w.title} / ${shotName}`, at: +(heard() - t0).toFixed(3) });
      }

      // ---- The shot list ---------------------------------------------------------------------
      let cues = [];
      let next = 0;
      // Kept in time order as they are added - foeBlow adds its guard mid-play, among the cues
      // still waiting to fire.
      function cue(beat, name, fn, early = 0) {
        const c = { beat, name, fn, t: at(beat) - early };
        let i = cues.length;
        while (i > next && cues[i - 1].t > c.t) i--;
        cues.splice(i, 0, c);
      }

      function buildV1() {
        const hook = cfg.hook;
        const [walkShot, strikeShot, blockShot, killShot] = ['walk', 'strike', 'block', 'kill']
          .map((k) => cfg.montage.find((m) => m.shot === k));
        const fields = ['wall', 'player', 'weapon', 'enemy'].map((k) => $(`${k}PromptInput`));

        // 0-8: the wizard.
        cue(0, 'wizard', () => {
          showOnly(screenSetup, 'setup');
          fields.forEach((f) => { f.value = ''; });
          typeInto(fields[0], hook.words.wall, 0, 1.4);
        });
        cue(1.5, 'type player', () => typeInto(fields[1], hook.words.player, 1.5, 3));
        cue(3.1, 'type weapon', () => typeInto(fields[2], hook.words.weapon, 3.1, 4));
        cue(4.1, 'type enemy', () => typeInto(fields[3], hook.words.enemy, 4.1, 5.3));
        cue(5.35, 'cursor', () => { fields[3].blur(); moveCursor(fields[3], btnCreate, 5.35, 5.95); });
        cue(6, 'CREATE', () => { press(btnCreate, 180); playSfx('button', { vary: 0 }); });
        cue(6.3, 'loading', () => {
          cursor.style.display = 'none';
          showOnly(screenProgress, 'progress');
          progHeaderIcon.textContent = '⏳';
          progHeaderText.textContent = 'Generating Dungeon Assets & Character...';
          progPhaseText.textContent = '';
          btnEnterDungeon.disabled = true;
          btnEnterDungeon.classList.remove('bg-yellow-100');
          btnEnterDungeon.textContent = 'GENERATING ASSETS';
          chip.style.display = 'inline-block';
          timelapseCrawl(worlds[hook.id].world.dungeonStory);
          zipLoading(6.3, 7.6);
        });
        cue(7.65, 'ready', () => {
          playSfx('ready');
          progHeaderIcon.textContent = '✅';
          progHeaderText.textContent = 'Generated!';
          progStatusText.textContent = 'Done.';
          btnEnterDungeon.disabled = false;
          btnEnterDungeon.classList.add('bg-yellow-100');
          btnEnterDungeon.textContent = `ENTER ${worlds[hook.id].title.toUpperCase()}`;
        });

        // 8-16: the drop, in the dungeon that was just typed.
        cue(7.85, 'ENTER', () => { press(btnEnterDungeon, 160); playSfx('button', { vary: 0 }); });
        cue(8, 'drop', () => { chip.style.display = 'none'; cut(hook.id, 'drop'); step(); });
        cue(9, 'step', step);
        cue(10, 'step into the foe', () => { pendingHp = 60; step(); });
        cue(12, 'strike', () => strike(false), STRIKE_LEAD);
        cue(12.45, 'arm blow', () => foeBlow(13, true));
        cue(14, 'kill', () => strike(true), STRIKE_LEAD);

        // 16-32: four more dungeons, one verb each.
        cue(16, 'walk', () => {
          cut(walkShot.id, 'walk');
          showCaption(walkShot.caption[0], walkShot.caption[1]);
          step();
        });
        cue(17, 'step', step);
        cue(18, 'turn', () => turn(currentShot.pose.turns[0] || 'R'));
        cue(19, 'step', step);

        cue(20, 'strike shot', () => {
          cut(strikeShot.id, 'strike'); fight('walker'); tether = true;
          showCaption(strikeShot.caption[0], strikeShot.caption[1]);
        });
        cue(21, 'strike', () => strike(false), STRIKE_LEAD);
        cue(21.45, 'arm blow', () => foeBlow(22, false));
        cue(23, 'strike', () => strike(false), STRIKE_LEAD);

        cue(24, 'block shot', () => {
          cut(blockShot.id, 'block'); fight('flyer'); tether = false;
          showCaption(blockShot.caption[0], blockShot.caption[1]);
          foeBlow(26, true);
        });
        cue(26.5, 'counter', () => strike(false), STRIKE_LEAD);

        cue(28, 'kill shot', () => {
          cut(killShot.id, 'kill'); fight('walker', 60); tether = true;
          showCaption(killShot.caption[0], killShot.caption[1]);
        });
        cue(29, 'strike', () => strike(false), STRIKE_LEAD);
        cue(30, 'kill', () => strike(true), STRIKE_LEAD);

        // 32-44: the rush. One walk, a new dungeon under it on the cut.
        cfg.rush.forEach((r, i) => {
          const b = RUSH_CUTS[i];
          cue(b, `rush ${i + 1}`, () => {
            tether = false;
            cut(r.id, 'rush');
            showCaption(r.caption[0], r.caption[1], i < 4 ? 0.4 : 0);
            step();
          });
          for (let k = 1; k < RUSH_STEPS[i]; k++) cue(b + k, 'step', step);
        });

        // 44-48: the tape-stops; back where it started, the thing that was typed, grown huge.
        cue(44, 'break', () => {
          cut(hook.id, 'boss');
          showCaption('The enemy is a', hook.words.enemy, 0.6);
        });
        cue(45, 'step', step);
        cue(46, 'step into the boss', () => { pendingHp = 80; step(); });
        cue(47.7, 'caption off', hideCaption);

        // 48-56: the boss, and the run's own ending.
        cue(48, 'strike', () => { tether = true; strike(false); }, STRIKE_LEAD);
        cue(48.45, 'arm blow', () => foeBlow(49, true));
        cue(50, 'strike', () => strike(false), STRIKE_LEAD);
        cue(51, 'strike', () => strike(false), STRIKE_LEAD);
        cue(52, 'final blow', () => strike(true), STRIKE_LEAD);
        cue(52.08, 'ending', () => playClip(null, true));
        cue(54, 'ending, cheer', () => playClip(clip.segs[1][0], true));

        if (cfg.strafe) strafeV1();

        // 56-64: the title.
        titleCues(56);
      }

      // Trailer 1.1 (trailer11.json): v1 beat for beat, plus left/right movement in its fights.
      // Every step ends before the next swing is called (STRIKE_LEAD ahead of its beat), so the
      // hits, the parries and the kills all land where v1's do.
      function strafeV1() {
        // The RAM GHOST: a step aside after the parry, and the kill comes from the new spot.
        sway(13.35, 13.72, 'left');
        // The T-rex: out to the right before its blow lands, back in for the second swing.
        sway(21.2, 21.6, 'right');
        sway(22.25, 22.68, 'left');
        // The blueberry fairy: a step left before it dives - the dive follows the hero there.
        sway(24.35, 24.85, 'left');
        // The gummy bear: a step each way between the two swings.
        sway(28.2, 28.65, 'right');
        sway(29.25, 29.68, 'left');
        // The boss: circling it between the last three swings.
        sway(49.35, 49.72, 'right');
        sway(50.3, 50.72, 'left');
      }

      // The title card, from `beat`: the name slams in, the tagline types, the call to action.
      function titleCues(beat) {
        const tag = tagline();
        cue(beat, 'title', showTitle);
        cue(beat + 2, 'tagline', () => typeText(endTag, tag, beat + 2, beat + 3.2));
        cue(beat + 4, 'call to action', () => { endCta.style.opacity = '1'; endWhere.style.opacity = '1'; });
        // A json's "outro" line fades in two beats before the music's last downbeat.
        if (cfg && cfg.outro) cue(62, 'outro', () => { endOutro.style.opacity = '1'; });
        cue(64.3, 'end', finish);
      }
      const tagline = () => (cfg && cfg.tagline) || 'Type anything. Crawl it.';

      // ---- v2: and it fights back ------------------------------------------------------------
      // Parade cuts: the first holds two beats so the pattern reads, then one foe per beat.
      const PARADE_CUTS = [28, 30, 31, 32, 33, 34, 35];

      function buildV2() {
        const [dodgeShot, packShot, blockShot] = ['dodge', 'pack', 'block']
          .map((k) => cfg.montage.find((m) => m.shot === k));
        const death = cfg.death, pitch = cfg.pitch, boss = cfg.boss;
        const fields = ['wall', 'player', 'weapon', 'enemy'].map((k) => $(`${k}PromptInput`));

        // 0-6: cold open. Mid-fight, low on health - and the next blow is the last.
        cue(0, 'cold open', () => {
          cut(death.id, 'fight');
          fight(death.foe || 'walker', 90);
          tether = true;
          mortal = true;
          combatState.playerHp = Math.round(combatState.playerMaxHp * 0.34);
          totalMoves = 43;   // the death box says how far this run got
        });
        cue(1, 'strike', () => strike(false), STRIKE_LEAD);
        cue(1.4, 'arm the killing blow', () => lethalBlow(2));
        // The game raises YOU DIED 700ms after the blow; the cursor finds Restart Dungeon.
        cue(4.3, 'cursor', () => moveCursor(viewportCanvas, btnRestartDungeon, 4.3, 5.2));
        cue(5.5, 'Restart Dungeon', () => { press(btnRestartDungeon, 180); playSfx('button', { vary: 0 }); });
        // 6-12: the same fight again - and this time the hero steps out of it.
        cue(6, 'restart', () => {
          cursor.style.display = 'none';
          mortal = false;
          cut(death.id, 'fight');
          fight(death.foe || 'walker', 60);
          tether = true;
        });
        cue(6.35, 'arm blow', () => foeBlow(7, false));
        dodge(7, 'right');
        cue(8, 'strike', () => strike(false), STRIKE_LEAD);
        cue(8.45, 'arm blow', () => foeBlow(9, true));
        cue(10, 'kill', () => strike(true), STRIKE_LEAD);

        // 12-16: the wizard. One blank typed, Fill-in writes the rest.
        cue(12, 'wizard', () => {
          tether = false;
          showOnly(screenSetup, 'setup');
          fields.forEach((f) => { f.value = ''; });
          syncFillInLabel();
          typeInto(fields[0], pitch.words.wall, 12, 12.8);
        });
        cue(12.9, 'cursor', () => { fields[0].blur(); moveCursor(fields[0], btnFillIn, 12.9, 13.4); });
        cue(13.5, 'Fill-in', () => {
          press(btnFillIn, 180);
          playSfx('button', { vary: 0 });
          const label = btnFillIn.querySelector('span');
          if (label) label.textContent = '⏳ Filling...';
        });
        cue(14.25, 'filled', () => {
          fields[1].value = pitch.words.player;
          fields[2].value = pitch.words.weapon;
          fields[3].value = pitch.words.enemy;
          syncFillInLabel();
          playSfx('ready', { gain: 0.5 });
        });
        cue(14.6, 'cursor', () => moveCursor(btnFillIn, btnCreate, 14.6, 15.2));
        cue(15.35, 'CREATE', () => { press(btnCreate, 180); playSfx('button', { vary: 0 }); });

        // 16-28: three fights, three moves.
        cue(16, 'dodge shot', () => {
          cursor.style.display = 'none';
          cut(dodgeShot.id, 'dodge'); fight(dodgeShot.foe || 'walker'); tether = true;
          showCaption(dodgeShot.caption[0], dodgeShot.caption[1]);
        });
        cue(17, 'strike', () => strike(false), STRIKE_LEAD);
        cue(17.4, 'arm blow', () => foeBlow(18, false));
        dodge(18, 'left');
        cue(19, 'strike', () => strike(false), STRIKE_LEAD);

        cue(20, 'pack shot', () => {
          cut(packShot.id, 'pack'); fight(packShot.foe || 'swarmer'); tether = false;
          showCaption(packShot.caption[0], packShot.caption[1]);
        });
        cue(21, 'cut one down', () => strike(true), STRIKE_LEAD);
        cue(21.45, 'arm blow', () => foeBlow(22, true));
        closeIn(23);
        cue(23, 'and another', () => strike(true), STRIKE_LEAD);

        cue(24, 'block shot', () => {
          cut(blockShot.id, 'block'); fight(blockShot.foe || 'flyer'); tether = false;
          showCaption(blockShot.caption[0], blockShot.caption[1]);
          foeBlow(26, true);
        });
        cue(26.5, 'counter', () => strike(false), STRIKE_LEAD);

        // 28-36: the parade - a new foe materialising on (nearly) every beat.
        cfg.parade.forEach((p, i) => {
          cue(PARADE_CUTS[i], `parade ${i + 1}`, () => {
            cut(p.id, 'parade');
            fight(p.foe || 'walker', 0, i === 0 ? 4 : 25);
            showCaption(p.caption[0], p.caption[1], i === 0 ? 0.4 : 0);
          });
        });

        // 36-40: the tape-stops; the dungeon that was filled in, its boss at the end of the hall.
        cue(36, 'break', () => {
          cut(boss.id, 'boss');
          showCaption(boss.caption[0], boss.caption[1], 0.6);
        });
        cue(37, 'step', step);
        cue(38, 'step into the boss', () => { pendingHp = 80; step(); });
        cue(39.7, 'caption off', hideCaption);

        // 40-54: one blow, then the charge - sidestepped - and the boss can't guard what follows.
        cue(40, 'strike', () => { tether = true; strike(false); }, STRIKE_LEAD);
        cue(40.45, 'charge', () => startCharge(46));
        cue(44.9, 'sidestep', () => hold('right', true));
        cue(45.75, 'stop', () => hold('right', false));
        cue(46.2, 'back in', () => hold('left', true));
        cue(46.7, 'stop', () => { hold('left', false); tether = true; });
        cue(47, 'strike', () => strike(false), STRIKE_LEAD);
        cue(48, 'strike', () => strike(false), STRIKE_LEAD);
        cue(49, 'final blow', () => strike(true), STRIKE_LEAD);
        cue(49.08, 'ending', () => playClip(null, true));
        cue(52, 'ending, cheer', () => playClip(clip.segs[1][0], true));

        // 54-64: the title.
        titleCues(54);
      }

      const SCRIPTS = {
        v1: {
          gate: 'Four blanks in, one dungeon out - and a dozen more after it.',
          music: { drop: 8, stop: 44, resume: 48, end: 64 },
          clip: () => ({ id: cfg.hook.id, segs: cfg.hook.clip }),
          cast() {
            const { cast, add } = castBuilder();
            add(cfg.hook.id, 'drop', { pattern: 'FFF', ahead: 0, foeOnPath: 'walker' });
            add(cfg.hook.id, 'boss', { boss: true });
            cfg.montage.forEach((m) => {
              if (m.shot === 'walk') add(m.id, 'walk', { pattern: 'FFTF', ahead: 3, foeAhead: 3 });
              else add(m.id, m.shot, FIGHT_POSE);
            });
            cfg.rush.forEach((r, i) => add(r.id, 'rush', { pattern: 'F'.repeat(RUSH_STEPS[i]), ahead: 2 }));
            return cast;
          },
          build: buildV1,
        },
        v2: {
          gate: 'Four blanks in. Then try to survive it.',
          music: { drop: 8, stop: 36, resume: 40, end: 64 },
          clip: () => ({ id: cfg.boss.id, segs: cfg.boss.clip }),
          cast() {
            const { cast, add } = castBuilder();
            add(cfg.death.id, 'fight', FIGHT_POSE);
            cfg.montage.forEach((m) => add(m.id, m.shot, FIGHT_POSE));
            cfg.parade.forEach((p) => add(p.id, 'parade', FIGHT_POSE));
            add(cfg.boss.id, 'boss', { boss: true });
            return cast;
          },
          build: buildV2,
        },
      };
      const S = () => SCRIPTS[(cfg && cfg.script) || 'v1'];

      function buildScript() {
        cues = [];
        S().build();
      }

      function typeText(el, text, fromBeat, toBeat) {
        tween((now) => {
          const p = Math.min(1, Math.max(0, (now - at(fromBeat)) / (at(toBeat) - at(fromBeat))));
          el.textContent = text.slice(0, Math.round(p * text.length));
          return p < 1;
        });
      }

      // The run's own cutscene, under the same white flash the game cuts to it with. Muted: the
      // trailer's track carries on under it. endingPhase 'playing' is the game's own freeze -
      // the fight stops and the raycaster stops drawing under the clip.
      function armClip(fromSec) {
        if (!clipUrl) return;
        if (endingVideoEl.getAttribute('src') !== clipUrl) endingVideoEl.src = clipUrl;
        endingVideoEl.muted = true;
        endingVideoEl.pause();
        try { endingVideoEl.currentTime = fromSec; } catch (e) { /* not seekable yet */ }
      }

      // fromSec null plays on from wherever armClip left it.
      function playClip(fromSec, flash) {
        if (!clipUrl) return;
        endingPhase = 'playing';
        releaseHeldKeys();
        if (battleModeBadge) {
          battleModeBadge.textContent = 'VICTORY';
          battleModeBadge.className = 'text-[9px] font-bold px-1.5 py-0.2 rounded bg-yellow-400 text-yellow-950';
        }
        if (endingVideoEl.getAttribute('src') !== clipUrl) endingVideoEl.src = clipUrl;
        endingVideoEl.muted = true;
        if (fromSec !== null) {
          try { endingVideoEl.currentTime = fromSec; } catch (e) { /* plays from wherever it is */ }
        }
        endingVideoEl.play().catch(() => {});
        endingCutscene.classList.remove('hidden');
        if (flash && endingFlash) {
          endingFlash.classList.remove('is-flashing');
          void endingFlash.offsetWidth;
          endingFlash.classList.add('is-flashing');
        }
      }
      function clearClip() {
        try { endingVideoEl.pause(); } catch (e) {}
        endingCutscene.classList.add('hidden');
        if (endingFlash) endingFlash.classList.remove('is-flashing');
        endingPhase = 'idle';
      }

      function showTitle() {
        tether = false;
        hideCaption();
        // Held at the game window's own size, so the window doesn't jump as the card comes up.
        const r = screenGame.getBoundingClientRect();
        clearClip();
        endCard.style.width = `${Math.round(r.width)}px`;
        // A json's "endHeight" (trailer12: 0.8) trims the card below the game window's height.
        // On the phone the game window is tall and narrow: the card keeps its width, stops at a
        // little taller than square, and its type is sized for the narrow width.
        const h = r.height * ((cfg && cfg.endHeight) || 1);
        endCard.style.height = `${Math.round(PHONE ? Math.min(h, r.width * 1.2) : h)}px`;
        endCard.style.fontSize = `${Math.max(11, Math.round(r.width * (PHONE ? 0.043 : 0.027)))}px`;
        showOnly(endCard, 'game');
        endTag.textContent = '';
        endCta.style.opacity = '0';
        endWhere.style.opacity = '0';
        endButtons.style.visibility = 'hidden';
        // A json's "outro" (trailer12) ends the card on a line of its own - for a recording, where
        // buttons would be dead pixels - instead of the Replay / Play buttons and the page's own
        // address. Laid out now, invisible, with the buttons already gone, so revealing it later
        // changes nothing but its opacity: filled in at the end, it grew the window.
        const outro = cfg && cfg.outro;
        endOutro.style.opacity = '0';
        endOutro.style.display = outro ? '' : 'none';
        endWhere.style.display = outro ? 'none' : '';
        endButtons.style.display = outro ? 'none' : '';
        if (outro) {
          const m = String(outro).match(/^(.*?)(https?:\/\/\S+)$/);
          endOutro.textContent = m ? m[1] : outro;
          if (m) { const b = document.createElement('b'); b.textContent = m[2]; endOutro.appendChild(b); }
        }
        [endIcon, endWord].forEach((el) => { el.classList.remove('te-slam'); void el.offsetWidth; el.classList.add('te-slam'); });
        playSfx('start', { vary: 0, gain: START_STING_GAIN });
      }

      // ---- Running it ------------------------------------------------------------------------
      let running = false;

      function frame() {
        if (!running) return;
        const now = heard();
        while (next < cues.length && cues[next].t <= now + 0.004) {
          const c = cues[next++];
          try { c.fn(); } catch (err) { console.error('[trailer] cue failed:', c.name, err); }
          log.push({ cue: c.name, beat: c.beat, late: +((now - c.t) * 1000).toFixed(1) });
        }
        tweens = tweens.filter((fn) => fn(now));
        if (captionTyping) {
          const p = Math.min(1, (now - captionTyping.from) / captionTyping.dur);
          capBlank.textContent = captionTyping.text.slice(0, Math.round(p * captionTyping.text.length));
          if (p >= 1) captionTyping = null;
        }
        // Grounded foes stay on the hero's line: the boss's patrol drift would otherwise walk it
        // out of reach of a strike that has to land on a beat.
        if (tether && combatState.inBattle) {
          for (const e of combatState.enemies) {
            const c = ENEMY_VARIANTS[e.variant] || {};
            if (e.hp > 0 && !c.fly) {
              e.x += (combatState.playerX - e.x) * 0.12;
              e.vx = 0;
              // No guard the script didn't ask for: the boss's random one is rolled per frame,
              // so frame timing decided whether it showed up - and the trailer is meant to
              // play the same way every time.
              e.noBlockTimer = Math.max(e.noBlockTimer, 2);
            }
          }
        }
        if (pendingHp && combatState.inBattle) { planHp(combatState.enemy, pendingHp); pendingHp = 0; }
        if (pin && pin.e.hp > 0) { pin.e.x = pin.x; pin.e.vx = 0; }
        if (approach) {
          const dx = approach.e.x - combatState.playerX;
          const on = Math.abs(dx) > 6 && approach.e.hp > 0;
          hold('left', on && dx < 0);
          hold('right', on && dx > 0);
          if (!on) approach = null;
        }
        if (charge) {
          const e = charge.e;
          if (e.special === 'weave') {
            // Weave until exactly the aim + wind-up + run-in before the arrival beat.
            const tail = (BOSS_PAUSE_FRAMES + BOSS_WINDUP_FRAMES + BOSS_RUSH_FRAMES) / 60;
            e.specialTimer = Math.max(1, Math.round((at(charge.arrive) - tail - now) * 60));
          } else if (e.special === 'none' && e.depth === 0) {
            charge = null;
          }
        }
        // Bars still move with every swing, hit and parry, but never low enough for the game's
        // low-health and out-of-breath vignettes: the trailer's hero is winning, and those
        // full-window overlays are the slowest thing the page can paint (a quarter-second
        // stutter over the boss's parry, measured). Not in the cold open, where it isn't.
        if (combatState.inBattle && !mortal && !combatState.dead) {
          combatState.playerHp = Math.max(combatState.playerHp, combatState.playerMaxHp * 0.6);
          combatState.playerStm = Math.max(combatState.playerStm, 45);
        }
        requestAnimationFrame(frame);
      }

      function play() {
        ctx = sfxContext();
        ctx.resume().catch(() => {});
        latency = Math.min(0.2, ctx.outputLatency || ctx.baseLatency || 0);
        running = true;
        pendingHp = 0;
        pin = null;
        charge = null;
        approach = null;
        mortal = false;
        window.__trailer.state = 'playing';
        log.length = 0;
        blocker.hidden = false;
        gate.remove();
        clearClip();
        hideCaption();
        tweens = [];
        armClip(clip.segs[0][0]);   // back to its first frame, for a replay
        // Scheduled a quarter second out, so the first cue has time to land before its beat.
        t0 = ctx.currentTime + 0.35 + Math.min(beats[0], 0.3);
        // Seconds since beat 0, as heard - for a test driving this page to time its checks by.
        window.__trailer.clock = () => heard() - t0;
        next = 0;
        buildScript();
        reseed('trailer/play');
        startMusic();
        requestAnimationFrame(frame);
      }

      function finish() {
        running = false;
        window.__trailer.state = 'done';
        blocker.hidden = true;
        endCta.style.opacity = '1';
        endWhere.style.opacity = '1';
        if (!endTag.textContent) endTag.textContent = tagline();
        if (cfg && cfg.outro) { endOutro.style.opacity = '1'; return; }   // see showTitle
        endButtons.style.visibility = 'visible';
        btnReplay.focus({ preventScroll: true });
      }

      // Esc during the trailer: straight to the title card, music off.
      function skipToEnd() {
        if (!running) return;
        running = false;
        stopMusicNow();
        cursor.style.display = 'none';
        chip.style.display = 'none';
        releaseHeldKeys();
        if (screenGame.classList.contains('hidden')) {
          // Still on the wizard or the loading bar: size the card like the game window would be.
          showOnly(screenGame, 'game');
        }
        showTitle();
        finish();
      }

      // Nothing the viewer presses reaches the game while the trailer runs - only Esc, to skip.
      window.addEventListener('keydown', (e) => {
        if (!running || e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(e.key)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === 'Escape') skipToEnd();
      }, true);

      btnReplay.addEventListener('click', () => { stopMusicNow(); play(); });
      btnPlayGame.addEventListener('click', () => { window.location.href = gameUrl; });
      // The two buttons are a row: arrows move between them, as in the game's own boxes.
      endButtons.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          (document.activeElement === btnReplay ? btnPlayGame : btnReplay).focus();
        }
      });

      // ---- The start screen ------------------------------------------------------------------
      // A browser won't play sound until the viewer clicks, so the trailer asks for that click -
      // and spends the wait loading everything it is about to show.
      const gate = document.createElement('div');
      gate.id = 'trailerGate';
      gate.innerHTML = `
        <div class="tg-box win95-box p-1" role="dialog" aria-modal="true" aria-labelledby="trailerGateTitle">
          <div class="win95-title text-xs flex items-center font-bold" id="trailerGateTitle">
            <span class="flex items-center gap-1.5">
              <img src="favicon.svg" alt="" width="16" height="16" style="image-rendering: pixelated;">
              <span class="tg-name">ComfyCrawler — the 30-second trailer</span>
            </span>
          </div>
          <div class="tg-body">
            <div class="tg-line">🔊 Sound on.</div>
            <div class="tg-bar win95-inset"><div class="tg-fill"></div></div>
            <div class="tg-status">Loading...</div>
            <button type="button" class="win95-btn" disabled>▶ Play trailer</button>
            <div style="font-size: 10px; color: #64748b; text-align: center;">Esc skips to the end.</div>
          </div>
        </div>`;
      document.body.appendChild(gate);
      const gateFill = gate.querySelector('.tg-fill');
      const gateStatus = gate.querySelector('.tg-status');
      const gatePlay = gate.querySelector('button');
      gatePlay.addEventListener('click', () => { if (window.__trailer.state === 'ready') play(); });

      // Behind the box: the wizard, blank, waiting to be typed into.
      showOnly(screenSetup, 'setup');
      ['wall', 'player', 'weapon', 'enemy'].forEach((k) => { const f = $(`${k}PromptInput`); if (f) f.value = ''; });

      // trailer12m: the page is only a phone on a desk - the trailer it names plays inside, with
      // ?phone. Sized like the user's own phone (412 CSS px wide) and scaled to fit the window.
      const PHONE_W = 412, PHONE_H = 880;
      function buildPhone(name) {
        gate.remove();
        blocker.remove();
        appContainer.style.display = 'none';
        const frame = document.createElement('div');
        frame.id = 'trailerPhone';
        frame.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;';
        const body = document.createElement('div');
        body.style.cssText = `width:${PHONE_W}px;height:${PHONE_H}px;padding:14px 10px;border-radius:38px;`
          + 'background:#111;box-shadow:0 25px 60px rgba(0,0,0,0.55), inset 0 0 0 2px #333;flex:none;';
        const screen = document.createElement('iframe');
        screen.title = document.title;
        screen.style.cssText = `width:${PHONE_W}px;height:${PHONE_H}px;border:0;border-radius:26px;background:#008080;display:block;`;
        // Straight at the export's folder (trailer12/), where a static host would redirect to it.
        screen.src = `${name}${SHOWCASE_MODE ? '/' : ''}?phone`;
        screen.addEventListener('load', () => screen.focus());
        body.appendChild(screen);
        frame.appendChild(body);
        document.body.appendChild(frame);
        const fit = () => {
          const k = Math.min(1, (window.innerHeight - 24) / (PHONE_H + 28), (window.innerWidth - 24) / (PHONE_W + 20));
          body.style.transform = `scale(${k})`;
        };
        fit();
        window.addEventListener('resize', fit);
        window.__trailer.state = 'phone';
        window.__trailer.screen = screen;
      }

      async function boot() {
        gatePlay.disabled = true;
        try {
          await loadConfig();
          if (cfg.phone && !PHONE) { buildPhone(cfg.phone); return; }
          await loadEverything((p, what) => {
            gateFill.style.width = `${Math.round(p * 100)}%`;
            if (what) gateStatus.textContent = what;
          });
          gateFill.style.width = '100%';
          gate.querySelector('.tg-line').textContent = `🔊 Sound on. ${S().gate}`;
          gateStatus.textContent = `Ready - ${Object.keys(worlds).length} dungeons loaded.`;
          window.__trailer.state = 'ready';
          gatePlay.disabled = false;
          gatePlay.focus({ preventScroll: true });
        } catch (err) {
          console.error('[trailer] loading failed:', err);
          window.__trailer.state = 'failed';
          gateStatus.textContent = `Couldn't load the trailer: ${err.message}`;
          gatePlay.textContent = '↻ Retry';
          gatePlay.disabled = false;
          gatePlay.onclick = () => window.location.reload();
        }
      }
      boot();
    })();
