    const SERVER_URL = "http://127.0.0.1:5555";

    const appContainer = document.getElementById('appContainer');
    const screenSetup = document.getElementById('screenSetup');
    const screenProgress = document.getElementById('screenProgress');
    const screenGame = document.getElementById('screenGame');
    const modalSettings = document.getElementById('modalSettings');
    const victoryModal = document.getElementById('victoryModal');
    const btnPlayAgain = document.getElementById('btnPlayAgain');
    const winMovesCount = document.getElementById('winMovesCount');
    const victoryText = document.getElementById('victoryText');
    const defeatModal = document.getElementById('defeatModal');
    const defeatText = document.getElementById('defeatText');
    const deadMovesCount = document.getElementById('deadMovesCount');
    const btnRestartDungeon = document.getElementById('btnRestartDungeon');
    const btnDeadNewDungeon = document.getElementById('btnDeadNewDungeon');

    // Engine mode is fixed at v6 (see activeMode below) - the picker was removed. The krea2
    // resolution / steps / portrait-res number inputs were removed too (never adjusted); the
    // server uses its own defaults. The only setup dropdowns left are graphics quality and
    // sound generation.
    const gfxQualitySelect = document.getElementById('gfxQualitySelect');
    const soundModeSelect = document.getElementById('soundModeSelect');
    const difficultyRow = document.getElementById('difficultyRow');
    const gridDesc = document.getElementById('gridDesc');

    // Maze size is a three-way difficulty pick, not a free slider - one knob with three
    // meanings instead of a number nobody knows how to read. 111 is the new ceiling
    // (generateAuthentic3DMaze used to clamp at 100).
    // `grids` is now the CARVED corridor count, not the finished tile count - the loop passes in
    // braidMaze() turn walls into floor on top of it. Measured over 500 mazes each, the three
    // settings below finish at about 36 / 74 / 123 walkable tiles. The HUD's "x/y Tiles" badge
    // reads passagesList, so it always shows the real number.
    const DIFFICULTIES = {
      easy:   { grids: 33,  desc: 'Easy: a small looping labyrinth - 33 carved corridors plus shortcuts, with a nearby Exit.' },
      medium: { grids: 66,  desc: 'Medium: 66 carved corridors plus shortcuts - branching routes, lanterns and a distant Exit.' },
      hard:   { grids: 111, desc: 'Hard: 111 carved corridors plus shortcuts - a sprawling, looping maze with a long, well-gated route to the Exit.' }
    };
    const MAX_GRIDS = 111;

    // How the maze is SHAPED, as opposed to how big it is. The generator used to emit a PERFECT
    // maze - a spanning tree, exactly one route between any two tiles - which plays as a single
    // hallway you follow, flipping whatever switch you happen to walk past, until it ends. These
    // three knobs make it MULTICURSAL: real loops, real junctions, real route choices.
    const MAZE = {
      // Fraction of carve steps that grow from a RANDOM frontier cell instead of the newest
      // one. 0 is a pure recursive backtracker: it commits to one direction until it runs out
      // of room, which makes long snaking corridors. Raising it grows several corridors at once
      // - bushier, more forks, but much shorter passages.
      //
      // It defaults to 0 because it turned out to be a bad way to buy junctions. Measured over
      // 250 hard mazes, raising it to 0.28 took the start->exit walk from 92 steps to 42 (a
      // shallower carve tree puts the furthest cell much nearer the spawn) and bought only ~5
      // extra junctions - while the braid knobs below buy ~19 junctions for ~29 steps. Left in
      // as a knob because it is the only lever on corridor LENGTH, but turn it up knowing it
      // shortens the whole dungeon.
      branchChance: 0,
      // Fraction of dead ends given a second opening. This is the classic braid, and it is what
      // actually creates loops: the corridor that led to the tip becomes a circuit. Deliberately
      // below 1 - placeGatesAndSwitches scores dead ends highest when hiding a lever, so braiding
      // them all away leaves it nowhere out-of-the-way to mount one.
      braidDeadEnds: 0.70,
      // Extra wall knock-outs between two already-connected cells, as a fraction of cell count.
      // Dead-end braiding only ties off the tips; these cut across the middle of long corridors,
      // which is what gives a route a choice partway along it instead of only at its end.
      extraLoops: 0.18
    };
    let selectedDifficulty = 'medium';
    const wallPromptInput = document.getElementById('wallPromptInput');
    const playerPromptInput = document.getElementById('playerPromptInput');
    const playerFileInput = document.getElementById('playerFileInput');
    const btnAttachPlayerImage = document.getElementById('btnAttachPlayerImage');
    const playerImageBadge = document.getElementById('playerImageBadge');
    const playerImageThumb = document.getElementById('playerImageThumb');
    const playerImageName = document.getElementById('playerImageName');
    const btnClearPlayerImage = document.getElementById('btnClearPlayerImage');
    let uploadedPlayerImageDataUrl = null;

    const weaponPromptInput = document.getElementById('weaponPromptInput');
    const enemyPromptInput = document.getElementById('enemyPromptInput');
    // Attached reference images, keyed the same way the request payload expects them.
    const attachedImages = { player: null, weapon: null, enemy: null };

    const btnCreate = document.getElementById('btnCreate');
    const btnSettings = document.getElementById('btnSettings');
    const btnCloseSettings = document.getElementById('btnCloseSettings');
    const btnSaveSettings = document.getElementById('btnSaveSettings');

    const progBarChunks = document.getElementById('progBarChunks');
    const progStatusText = document.getElementById('progStatusText');
    const progPercentText = document.getElementById('progPercentText');
    const progTimer = document.getElementById('progTimer');
    const progSubText = document.getElementById('progSubText');
    const crawlStage = document.getElementById('crawlStage');
    const crawlText = document.getElementById('crawlText');
    const crawlPending = document.getElementById('crawlPending');
    const btnEnterDungeon = document.getElementById('btnEnterDungeon');
    const btnNarrateManual = document.getElementById('btnNarrateManual');
    const progHeaderText = document.getElementById('progHeaderText');
    const progHeaderIcon = document.getElementById('progHeaderIcon');

    const viewportCanvas = document.getElementById('viewportCanvas');
    const gameVideo = document.getElementById('gameVideo');
    const statusPos = document.getElementById('statusPos');
    const mapProgressBadge = document.getElementById('mapProgressBadge');

    const titleButtons = document.getElementById('titleButtons');
    const btnUp = document.getElementById('btnUp');
    const btnDown = document.getElementById('btnDown');
    const btnLeft = document.getElementById('btnLeft');
    const btnRight = document.getElementById('btnRight');
    const btnAction = document.getElementById('btnAction');
    const btnMaximize = document.getElementById('btnMaximize');
    const btnClose = document.getElementById('btnClose');

    // ==========================================
    // RAYCASTER MAZE & TEXTURE ENGINE
    // ==========================================
    const screenWidth = 320;
    const screenHeight = 240;

    // Wall height in world units (one map cell is 1x1) and how far the camera sits BEHIND the
    // player's cell centre. Together these decide how much of the screen a faced wall covers:
    // coverage = WALL_HEIGHT / (0.5 + CAMERA_SETBACK), so ~0.62/0.92 = 67%, always leaving bands of
    // ceiling and floor with room for a duel.
    //
    // Both knobs are needed. Movement is strictly grid based, so a faced wall is otherwise ALWAYS
    // exactly 0.5 away and towers over the screen. Shortening walls alone does buy the headroom,
    // but at 0.36 (the value that works on its own) corridors turn into a squat crawlspace, because
    // it shrinks distant walls just as much as near ones. The setback only affects what is directly
    // ahead, so corridors keep their height.
    //
    // Both replace an earlier attempt that clamped the projected DISTANCE per column. That broke
    // perspective outright: near walls were drawn at a distance they weren't at, so their textures
    // compressed, and the near ends of side walls were cut short - which read as corridors opening
    // to the left and right that did not exist.
    const WALL_HEIGHT = 0.62;
    const CAMERA_SETBACK = 0.42;
    const TEX_SIZE = 256;

    // Texels per world unit on the floor and ceiling. This MUST stay exactly TEX_SIZE: the sampler
    // masks with & (TEX_SIZE - 1), so one full texture then lands on exactly one 1x1 map cell,
    // aligned to the cell boundaries. Any other value tiles at a rate that does not divide the
    // grid, and the texture's own seam lands somewhere in the middle of a cell instead of on its
    // edge - which is what put a second, off-centre copy of the floor and ceiling art inside every
    // square. (The previous TEX_SIZE / WALL_HEIGHT was a density tweak to counter the eye sitting
    // at WALL_HEIGHT/2 rather than 0.5; it fixed the grain and broke the alignment. Grain is a
    // texture-generation problem, not a UV one - fix it in the prompt, not here.)
    const SURFACE_TEXELS = TEX_SIZE;

    let ctx = viewportCanvas.getContext('2d');
    let imgData = ctx.createImageData(screenWidth, screenHeight);
    let buffer = imgData.data;

    let wallTexture = null;
    let ceilingTexture = null;
    let floorTexture = null;
    let wallLanternTexture = null;
    // The descending stairwell that marks the exit cell - see buildExitStairsTexture. Rebuilt
    // per dungeon so it is cut from that theme's own stone.
    let exitStairsTexture = null;
    // AI-generated wall fixture (torch/lantern/lamp) matted onto wallLanternTexture in
    // buildLanternWallFromBase. Null falls back to the procedural shapes drawn there.
    let aiLanternImg = null;

    // Door / switch textures - built the same way as wallLanternTexture (a full-cell wall
    // texture, selected in render3D's wall dispatch by MAP tile value: 3=closed door,
    // 4=switch OFF, 5=switch ON; 6=opened door, which is walkable and drawn as a sprite). The
    // aiDoorImg / aiSwitchImg / aiSwitchOnImg are the style-matched cutouts the builders
    // composite in; null falls back to procedural shapes. Off and on are two SEPARATELY
    // generated images (see get_gate_prompts on the server), not one derived from the other -
    // the fixture just has a different pose in each, no colour or lighting difference. See
    // buildDoorTexture / buildSwitchWallTextures.
    let doorTexture = null;
    // The open gate (MAP tile 6) is a see-through billboard, not a wall texture - see
    // buildOpenDoorTexture and the open-gate pass at the end of render3D.
    let doorOpenTexture = null;
    const DOOR_SPR_W = 256, DOOR_SPR_H = 160;
    let switchWallOffTexture = null;
    let switchWallOnTexture = null;
    let aiDoorImg = null;
    let aiSwitchImg = null;
    let aiSwitchOnImg = null;

    let playerSpriteImg = null;
    let playerFaceImg = null;
    let playerSpriteFrames = [];
    // v5 (krea2) generates the weapon and shield as their own transparent sprites; the rig
    // draws these instead of the procedural bezier gear. Null in every other mode.
    let weaponSpriteImg = null;
    let shieldSpriteImg = null;
    let enemySpriteFrames = [];
    // The three foes generated from one typed enemy idea (server bundle.enemy_variants):
    // walker (ground), flyer (swoops from out of reach), boss (big, tanky). One is chosen
    // at random each time a battle starts. enemySpriteFrames tracks the active one.
    // {variant: {idle, attack, block}} of Images. Every foe has idle+attack; only the two
    // that fight on the ground have block. enemyFrames below points at the active foe's set.
    let enemyVariantImgs = {};
    let enemyFrames = null;
    let enemyStyleName = '';   // common foe name (walker/flyer)
    let enemyBossName = '';    // boss's own name (boss variant only)
    // Each foe's own invented name (server bundle.enemy_names), when the three were designed
    // as separate species rather than derived from one another. Takes precedence over the
    // tag+common-name fallback below, because these really are three different creatures.
    let enemyVariantNames = {};
    // The generated intro: {location, hero, foe, boss, crawl:[...]}. Arrives from
    // /api/progress minutes before the art does, and names the enemies in combat.
    let dungeonStory = null;
    // Set once generation finishes; the player enters on their own schedule, not ours.
    let pendingBundle = null;
    let crawlStarted = false;

    // ---- Intro narration (Piper, pre-rendered server-side) -----------------
    // The server picks one narrator (alan or kristin) per story and ships back one WAV
    // clip per paragraph as a data URL in bundle.story.audio, in the same order as the
    // <p> elements startCrawl() builds - title first, then each crawl paragraph. Playback
    // is just one <audio> element working through that list; no voice picking, no
    // getVoices()/voiceschanged race, no Chrome pause-queue bug - all of that lived on the
    // browser-TTS side and none of it applies to a plain audio file.
    // Always on. There was a "Narrate the intro" checkbox (and a remembered
    // comfycrawler.narrate preference) here; the narration is the point of the loading screen
    // and now also cues the loading music, so it is no longer optional.

    // A beat of silence after the title and after each paragraph, so the crawl reads like
    // it's being spoken deliberately rather than one clip barging straight into the next.
    const NARRATE_PAUSE_MS = 700;

    let narrateAudio = null;       // one <audio> element, reused clip to clip
    let narrateClips = [];         // [{el: <p>, src: dataUrl}, ...] for the active story
    let narrateIndex = 0;
    let narrateStartCheck = null;
    let narratePauseTimer = null;

    function stopNarration() {
      restoreMenuMusic();       // no-op unless narration actually faded it out
      if (narratePauseTimer) { clearTimeout(narratePauseTimer); narratePauseTimer = null; }
      if (narrateStartCheck) { clearTimeout(narrateStartCheck); narrateStartCheck = null; }
      if (btnNarrateManual) btnNarrateManual.classList.add('hidden');
      if (narrateAudio) {
        try { narrateAudio.pause(); } catch (e) {}
        narrateAudio.removeAttribute('src');
      }
      if (crawlText) {
        crawlText.classList.remove('narrating');
        crawlText.querySelectorAll('p.speaking').forEach(p => p.classList.remove('speaking'));
      }
      narrateClips = [];
      narrateIndex = 0;
    }

    // True while there are clips queued for this story - narration is either speaking or
    // between paragraphs. The music hand-off waits on this: see armEnterDungeon.
    function narrationActive() {
      return narrateClips.length > 0;
    }

    // The narrator reaching the end of the crawl, as opposed to stopNarration()'s other
    // callers (a new dungeon, leaving for the game, unload), which are teardown and must not
    // start anything. This is the one that scores the rest of the loading screen.
    function finishNarration() {
      stopNarration();
      playScreenMusic('loading');
    }

    function playNarrationClip(i) {
      narrateIndex = i;
      narrateClips.forEach((c, idx) => c.el.classList.toggle('speaking', idx === i));
      if (i >= narrateClips.length) { finishNarration(); return; }
      narrateAudio.src = narrateClips[i].src;
      const p = narrateAudio.play();
      // A rejected promise (autoplay blocked) is handled by the startCheck timeout below,
      // not here - retrying belongs to a real click, not to code running the instant the
      // browser said no.
      if (p && p.catch) p.catch(() => {});
    }

    function advanceNarration() {
      if (narrateStartCheck) { clearTimeout(narrateStartCheck); narrateStartCheck = null; }
      if (btnNarrateManual) btnNarrateManual.classList.add('hidden');
      // Drop the highlight for the pause itself, so the dimming reads as part of the beat
      // rather than a jump-cut straight to the next line.
      narrateClips.forEach(c => c.el.classList.remove('speaking'));
      const next = narrateIndex + 1;
      if (next >= narrateClips.length) { finishNarration(); return; }
      narratePauseTimer = setTimeout(() => {
        narratePauseTimer = null;
        playNarrationClip(next);
      }, NARRATE_PAUSE_MS);
    }

    // Called on a real user click when autoplay blocked the first clip. narrateAudio.src
    // is still set to that same clip - nothing played yet - so this just retries it.
    function retryNarrationPlay() {
      if (!narrateAudio) return;
      if (btnNarrateManual) btnNarrateManual.classList.add('hidden');
      const p = narrateAudio.play();
      if (p && p.catch) p.catch(() => {
        if (btnNarrateManual) btnNarrateManual.classList.remove('hidden');
      });
    }

    function startNarration() {
      if (!crawlText) return;
      if (screenProgress.classList.contains('hidden')) return;
      const story = dungeonStory;
      if (!story || !Array.isArray(story.audio) || !story.audio.length) return;

      const paras = Array.from(crawlText.querySelectorAll('p'));
      const n = Math.min(paras.length, story.audio.length);
      if (!n) return;

      stopNarration();
      fadeOutMenuMusicForNarration();   // narration is about to actually speak - see stopNarration
                                        // above for the matching restore when it finishes
      crawlText.classList.add('narrating');
      for (let i = 0; i < n; i++) narrateClips.push({ el: paras[i], src: story.audio[i] });

      if (!narrateAudio) {
        narrateAudio = new Audio();
        narrateAudio.addEventListener('ended', advanceNarration);
        narrateAudio.addEventListener('error', advanceNarration);
      }
      playNarrationClip(0);

      // A blocked autoplay never fires 'play', 'ended' or 'error' - it just silently does
      // nothing. Without this check a blocked narrator looks identical to a broken one.
      narrateStartCheck = setTimeout(() => {
        if (narrateAudio.paused && btnNarrateManual) btnNarrateManual.classList.remove('hidden');
      }, 1500);
    }

    if (btnNarrateManual) {
      btnNarrateManual.addEventListener('click', () => {
        if (narrateClips.length) retryNarrationPlay();
        else startNarration();
      });
    }
    window.addEventListener('beforeunload', stopNarration);

    // ---- Sound effects (Stable Audio 3, generated per dungeon) -------------
    // The server ships bundle.sfx as {name: 'data:audio/wav;base64,...'} - eight one-shots
    // written from the same typed styles the art comes from, so the footstep matches the
    // floor and the swing matches the weapon.
    //
    // Web Audio rather than <audio> elements (which is what the narration above uses): a
    // one-shot has to overlap itself and be pitch-varied per hit, and an <audio> element
    // can do neither. The narration is a single long clip played once, so it keeps its
    // simpler path.
    //
    // Anything missing from the bundle - an older v3/v4/v5 dungeon, a clip that failed the
    // server's validator, a machine with no audio checkpoint - falls through to synthSfx(),
    // so the game is never silent and never throws over sound.
    // No mute UI - both always play. Web Audio still respects the OS/browser volume, and a
    // silent-by-preference player can just mute the tab.
    let audioCtx = null;
    let sfxMaster = null;
    let sfxBank = {};              // name -> AudioBuffer, for whatever the bundle supplied
    const sfxOn = true;

    let musicMaster = null;
    const musicOn = true;
    let musicBank = {};            // 'explore'/'battle' -> AudioBuffer
    let musicNodes = {};           // 'explore'/'battle' -> { src, gain }
    // A sub-bus carrying ONLY the dungeon's own explore/battle beds, so they can be ducked
    // under a screen loop and brought straight back. The menu and screen loops bypass it and
    // hang off musicMaster directly - ducking must not touch the thing being ducked FOR.
    // Without it the only way to quiet the dungeon was fadeOutDungeonMusic, which tears the
    // looping nodes down; getting them back would mean re-decoding the whole bank.
    let dungeonMusicBus = null;

    function sfxContext() {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        audioCtx = new AC();
        sfxMaster = audioCtx.createGain();
        sfxMaster.gain.value = 0.85;
        sfxMaster.connect(audioCtx.destination);
        musicMaster = audioCtx.createGain();
        musicMaster.gain.value = 0.6;
        musicMaster.connect(audioCtx.destination);
        dungeonMusicBus = audioCtx.createGain();
        dungeonMusicBus.gain.value = 1;
        dungeonMusicBus.connect(musicMaster);
      }
      // Created suspended under the autoplay policy until a real gesture resumes it. The
      // first-gesture listener below does that; resuming again here is harmless and covers
      // a context that got suspended later (backgrounded tab).
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      return audioCtx;
    }

    function loadSfxBank(sfx) {
      // The UI sounds are static and shared across dungeons - carry them over rather than
      // re-fetching them on every entry.
      const kept = {};
      UI_SOUNDS.forEach(n => { if (sfxBank[n]) kept[n] = sfxBank[n]; });
      sfxBank = kept;
      if (!sfx) return;            // other modes / a failed pack: synthSfx covers everything
      const ctx = sfxContext();
      if (!ctx) return;
      Object.keys(sfx).forEach(name => {
        try {
          const b64 = sfx[name].split(',')[1];
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          // Callback form, not the promise: Safari still ships the old signature.
          ctx.decodeAudioData(bytes.buffer, buf => { sfxBank[name] = buf; }, () => {});
        } catch (e) { /* one bad clip must not cost the other seven */ }
      });
    }

    // ---- Background music (Stable Audio 3, generated per dungeon, v6-only) -------------
    // The server ships bundle.music as {explore: 'data:audio/wav;base64,...', battle: ...} -
    // two ~30s tracks pre-crossfaded at their own loop seam server-side. Unlike sfx one-shots,
    // each track is a single long-lived looping AudioBufferSourceNode; toggleBattleMode
    // crossfades between them via setMusicMode rather than starting/stopping nodes.

    function stopMusic() {
      Object.values(musicNodes).forEach(node => {
        try { node.src.stop(); } catch (e) { /* already stopped */ }
        try { node.src.disconnect(); node.gain.disconnect(); } catch (e) { /* already gone */ }
      });
      musicNodes = {};
      musicBank = {};
    }

    function loadMusicBank(music) {
      stopMusic();                 // always tear down the previous dungeon's loops first
      if (!music) return;          // sound_mode wasn't "music_and_sound", or generation failed
      const ctx = sfxContext();
      if (!ctx) return;
      ['explore', 'battle'].forEach(name => {
        if (!music[name]) return;
        try {
          const b64 = music[name].split(',')[1];
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          ctx.decodeAudioData(bytes.buffer, buf => {
            musicBank[name] = buf;
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.loop = true;
            const g = ctx.createGain();
            // Read combat state at the moment playback actually starts, not a hardcoded
            // default - a battle toggle could in principle land between request and decode.
            g.gain.value = ((name === 'battle') === combatState.inBattle) ? 1 : 0;
            src.connect(g); g.connect(dungeonMusicBus || musicMaster);
            src.start();
            musicNodes[name] = { src, gain: g };
          }, () => {});
        } catch (e) { /* one missing track must not cost the other */ }
      });
    }

    // The run is over (death, victory) and the loading loop is about to take the screen.
    // stopMusic() alone is a hard cut in the middle of a bar; this rides the beds down first
    // and tears them down after. The caller is responsible for the delay - both call sites
    // already wait before revealing their box.
    function fadeOutDungeonMusic(sec) {
      const ctx = sfxContext();
      if (!ctx) { stopMusic(); return; }
      const now = ctx.currentTime;
      Object.values(musicNodes).forEach(node => {
        node.gain.gain.cancelScheduledValues(now);
        node.gain.gain.setValueAtTime(node.gain.gain.value, now);
        node.gain.gain.linearRampToValueAtTime(0, now + sec);
      });
      setTimeout(stopMusic, sec * 1000 + 100);
    }

    // Pull the dungeon's bed down (or back up) without stopping it, so a screen loop can take
    // the foreground for a moment and hand it straight back. `level` is a multiplier on the
    // whole dungeon bus: 0 silences the beds, 1 restores them, and the explore/battle balance
    // underneath is untouched throughout.
    function duckDungeonMusic(level, sec) {
      const ctx = sfxContext();
      if (!ctx || !dungeonMusicBus) return;
      const now = ctx.currentTime;
      const g = dungeonMusicBus.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(level, now + Math.max(0.01, sec));
    }

    // Single call site drives both directions of the explore/battle crossfade.
    function setMusicMode(inBattle) {
      const ctx = sfxContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const dur = 1.5;
      ['explore', 'battle'].forEach(name => {
        const node = musicNodes[name];
        if (!node) return;
        const target = ((name === 'battle') === inBattle) ? 1 : 0;
        node.gain.gain.cancelScheduledValues(now);
        node.gain.gain.setValueAtTime(node.gain.gain.value, now);   // anchor before ramping
        node.gain.gain.linearRampToValueAtTime(target, now + dur);
      });
    }

    // ---- Main menu music (static, generated once, NOT per-dungeon) -------------
    // sounds/menu_music.wav is a fixed short loop, unlike explore/battle which are themed
    // per playthrough - see generate_menu_music_asset in server.py. Plays from the moment
    // the title screen is usable through the whole loading screen, fading out under the intro
    // narration and stopping for good once assets are ready and the "ready" chime plays.
    const MENU_MUSIC_VOLUME = 0.4125;     // was 0.75, then lowered 45% - much quieter than dungeon music
    let menuMusicBuf = null;
    let menuMusicLoading = false;
    let menuMusicNode = null;      // { src, gain } while actually playing
    let menuMusicStopped = false;  // true once the ready chime has silenced it for this run
    let menuMusicFaded = false;    // true while narration has faded it out (node kept alive for restore)

    function _spawnMenuMusicNode(initialGain) {
      const ctx = sfxContext();
      if (!ctx || !menuMusicBuf) return null;
      const src = ctx.createBufferSource();
      src.buffer = menuMusicBuf;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = initialGain;
      src.connect(g); g.connect(musicMaster);
      src.start();
      return { src, gain: g };
    }

    function loadMenuMusic() {
      if (menuMusicBuf || menuMusicLoading) return;
      const ctx = sfxContext();
      if (!ctx) return;
      menuMusicLoading = true;
      fetch(`${SERVER_URL}/sounds/menu_music.wav`)
        .then(r => (r.ok ? r.arrayBuffer() : Promise.reject()))
        .then(ab => ctx.decodeAudioData(ab, buf => {
          menuMusicBuf = buf;
          menuMusicLoading = false;
          if (!menuMusicNode && !menuMusicStopped) menuMusicNode = _spawnMenuMusicNode(MENU_MUSIC_VOLUME);
        }, () => { menuMusicLoading = false; }))
        .catch(() => { menuMusicLoading = false; /* menu just plays without music */ });
    }

    function stopMenuMusicLoop() {
      if (!menuMusicNode) return;
      const node = menuMusicNode;
      menuMusicNode = null;
      try { node.src.stop(); } catch (e) {}
      try { node.src.disconnect(); node.gain.disconnect(); } catch (e) {}
    }

    // Retires the menu loop for the rest of the run. Called from playScreenMusic() - whichever
    // screen track comes up first (normally the loading loop, the moment the narrator stops)
    // is what the menu loop hands off to, and it never comes back until returnToMenuMusic().
    function stopMenuMusicForLoadingComplete() {
      menuMusicStopped = true;
      menuMusicFaded = false;
      if (!menuMusicNode) return;
      const ctx = sfxContext();
      const now = ctx ? ctx.currentTime : 0;
      const node = menuMusicNode;
      node.gain.gain.cancelScheduledValues(now);
      node.gain.gain.setValueAtTime(node.gain.gain.value, now);
      node.gain.gain.linearRampToValueAtTime(0, now + 0.6);
      menuMusicNode = null;
      setTimeout(() => {
        try { node.src.stop(); node.src.disconnect(); node.gain.disconnect(); } catch (e) {}
      }, 700);
    }

    // Fades the menu music all the way out for the intro narration - the loop keeps running
    // silently so restoreMenuMusic() can bring it back if the narration is skipped. A no-op if
    // narration is off (never called), if the menu music failed to load, or if the
    // loading-complete chime already stopped it for good.
    function fadeOutMenuMusicForNarration() {
      if (!menuMusicNode || menuMusicStopped || menuMusicFaded) return;
      menuMusicFaded = true;
      const ctx = sfxContext();
      const now = ctx.currentTime;
      menuMusicNode.gain.gain.cancelScheduledValues(now);
      menuMusicNode.gain.gain.setValueAtTime(menuMusicNode.gain.gain.value, now);
      menuMusicNode.gain.gain.linearRampToValueAtTime(0, now + 1.5);
    }

    function restoreMenuMusic() {
      if (!menuMusicNode || menuMusicStopped || !menuMusicFaded) return;
      menuMusicFaded = false;
      const ctx = sfxContext();
      const now = ctx.currentTime;
      menuMusicNode.gain.gain.cancelScheduledValues(now);
      menuMusicNode.gain.gain.setValueAtTime(menuMusicNode.gain.gain.value, now);
      menuMusicNode.gain.gain.linearRampToValueAtTime(MENU_MUSIC_VOLUME, now + 0.6);
    }

    // Win, lose, or quit back to the title screen: the dungeon's own music must stop, and the
    // menu loop restarts from silence and eases back up rather than snapping to full volume.
    // The win or death loop has been running underneath its box, so it fades down across the
    // same beat the menu loop is fading up - a crossfade, not a hard cut.
    function returnToMenuMusic() {
      stopMusic();
      stopScreenMusic(2.0);
      stopMenuMusicLoop();
      menuMusicStopped = false;
      menuMusicFaded = false;
      if (!menuMusicBuf) { loadMenuMusic(); return; }
      menuMusicNode = _spawnMenuMusicNode(0);
      if (!menuMusicNode) return;
      const ctx = sfxContext();
      menuMusicNode.gain.gain.linearRampToValueAtTime(MENU_MUSIC_VOLUME, ctx.currentTime + 3.0);
    }

    // ---- Screen music (static, generated once, NOT per-dungeon) -------------
    // Four more fixed loops alongside the menu one, served from sounds/<name>_music.wav -
    // see STATIC_MUSIC in server.py:
    //   loading  picks up exactly where the intro narration puts it down and carries the
    //            loading screen to the ENTER button
    //   death    under the death box
    //   victory  under the victory box
    //   levelup  under the level-up choice box. The odd one out: it plays DURING a run rather
    //            than over a box that ends one, so instead of the dungeon's bed being faded
    //            out under it, the bed is ducked on dungeonMusicBus and handed straight back.
    // Exactly one of these and the menu loop is ever audible: playScreenMusic() retires the
    // menu loop for the run and cross-fades off whichever screen track was already up, and
    // returnToMenuMusic() fades the lot out as the menu comes back.
    const SCREEN_MUSIC_VOLUME = 0.4125;   // same bed level as the menu loop
    const SCREEN_MUSIC_FADE_IN = 1.5;
    const SCREEN_MUSIC_FADE_OUT = 0.6;
    let screenMusicBufs = {};      // name -> AudioBuffer, once fetched and decoded
    let screenMusicLoading = {};   // name -> true while its fetch is in flight
    let screenMusicNode = null;    // { name, src, gain } while actually playing
    // The track playScreenMusic() was asked for. Held separately from screenMusicNode so a
    // request made before the buffer arrives can still start on decode - and so that a
    // stopScreenMusic() in between cancels it, which is what keeps a track requested at the
    // death box from starting after the player has already restarted out of it.
    let screenMusicWanted = null;

    function loadScreenMusic(name) {
      if (screenMusicBufs[name] || screenMusicLoading[name]) return;
      const ctx = sfxContext();
      if (!ctx) return;
      screenMusicLoading[name] = true;
      fetch(`${SERVER_URL}/sounds/${name}_music.wav`)
        .then(r => (r.ok ? r.arrayBuffer() : Promise.reject()))
        .then(ab => ctx.decodeAudioData(ab, buf => {
          screenMusicBufs[name] = buf;
          screenMusicLoading[name] = false;
          // Whatever was wanted may have changed (or been cancelled) while this downloaded.
          if (screenMusicWanted === name && !screenMusicNode) playScreenMusic(name);
        }, () => { screenMusicLoading[name] = false; }))
        .catch(() => { screenMusicLoading[name] = false; /* that screen runs silent */ });
    }

    // Idempotent per track: every trigger (narration ending, the victory box, the death box)
    // can call this without checking what is already playing.
    function playScreenMusic(name) {
      screenMusicWanted = name;
      stopMenuMusicForLoadingComplete();   // the menu loop's job is over for this run
      if (screenMusicNode && screenMusicNode.name === name) return;
      _fadeOutScreenMusicNode(SCREEN_MUSIC_FADE_OUT);   // swapping tracks, not stopping
      if (!screenMusicBufs[name]) { loadScreenMusic(name); return; }
      const ctx = sfxContext();
      if (!ctx) return;
      const src = ctx.createBufferSource();
      src.buffer = screenMusicBufs[name];
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(g); g.connect(musicMaster);
      src.start();
      g.gain.linearRampToValueAtTime(SCREEN_MUSIC_VOLUME, ctx.currentTime + SCREEN_MUSIC_FADE_IN);
      screenMusicNode = { name, src, gain: g };
    }

    // Rides the current node down and tears it down after, without touching screenMusicWanted
    // - playScreenMusic uses it to cross-fade, stopScreenMusic to actually stop.
    function _fadeOutScreenMusicNode(fadeSec) {
      if (!screenMusicNode) return;
      const node = screenMusicNode;
      screenMusicNode = null;
      const ctx = sfxContext();
      if (!ctx || fadeSec <= 0) {
        try { node.src.stop(); node.src.disconnect(); node.gain.disconnect(); } catch (e) {}
        return;
      }
      const now = ctx.currentTime;
      node.gain.gain.cancelScheduledValues(now);
      node.gain.gain.setValueAtTime(node.gain.gain.value, now);
      node.gain.gain.linearRampToValueAtTime(0, now + fadeSec);
      setTimeout(() => {
        try { node.src.stop(); node.src.disconnect(); node.gain.disconnect(); } catch (e) {}
      }, fadeSec * 1000 + 100);
    }

    function stopScreenMusic(fadeSec) {
      screenMusicWanted = null;
      _fadeOutScreenMusicNode(fadeSec === undefined ? SCREEN_MUSIC_FADE_OUT : fadeSec);
    }

    // Procedural stand-ins. Deliberately crude - shaped noise through a filter with a
    // percussive envelope - because their whole job is to keep the game audible when the
    // generated pack is missing, not to compete with it.
    const SYNTH_SFX = {
      step:         { f: 620,  q: 1.2, dur: 0.11, type: 'lowpass',  gain: 0.30, sweep: 0.55 },
      bump:         { f: 180,  q: 1.0, dur: 0.16, type: 'lowpass',  gain: 0.45, sweep: 0.60 },
      turn:         { f: 500,  q: 1.0, dur: 0.08, type: 'lowpass',  gain: 0.18, sweep: 0.65 },
      attack:       { f: 2400, q: 0.8, dur: 0.20, type: 'bandpass', gain: 0.35, sweep: 0.30 },
      miss_enemy:   { f: 1800, q: 0.6, dur: 0.24, type: 'bandpass', gain: 0.28, sweep: 0.20 },
      block:        { f: 1400, q: 4.0, dur: 0.26, type: 'bandpass', gain: 0.45, sweep: 0.70 },
      miss_player:  { f: 1600, q: 0.6, dur: 0.26, type: 'bandpass', gain: 0.28, sweep: 0.20 },
      hit_enemy:    { f: 420,  q: 1.4, dur: 0.20, type: 'lowpass',  gain: 0.50, sweep: 0.45 },
      hit_player:   { f: 300,  q: 1.4, dur: 0.24, type: 'lowpass',  gain: 0.55, sweep: 0.40 },
      death_enemy:  { f: 260,  q: 2.0, dur: 0.70, type: 'lowpass',  gain: 0.50, sweep: 0.25 },
      death_player: { f: 200,  q: 2.0, dur: 0.90, type: 'lowpass',  gain: 0.60, sweep: 0.20 }
    };

    function synthSfx(name, rate) {
      const ctx = sfxContext();
      if (!ctx) return;
      const cfg = SYNTH_SFX[name] || SYNTH_SFX.step;
      const dur = cfg.dur / (rate || 1);
      const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buf = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) {
        // Noise under an exponential decay - the envelope is what makes it read as a hit
        // rather than a hiss.
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.5);
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const filt = ctx.createBiquadFilter();
      filt.type = cfg.type;
      filt.Q.value = cfg.q;
      const f0 = cfg.f * (rate || 1);
      filt.frequency.setValueAtTime(f0, ctx.currentTime);
      filt.frequency.exponentialRampToValueAtTime(Math.max(40, f0 * cfg.sweep),
                                                  ctx.currentTime + dur);
      const g = ctx.createGain();
      g.gain.value = cfg.gain;
      src.connect(filt); filt.connect(g); g.connect(sfxMaster);
      src.start();
    }

    // Every in-game sound goes through here. `vary` is the pitch/level jitter that stops a
    // corridor of footsteps sounding like one sample on a loop.
    function playSfx(name, opts) {
      if (!sfxOn) return;
      const o = opts || {};
      const vary = o.vary === undefined ? 0.08 : o.vary;
      const rate = (o.rate || 1) * (1 + (Math.random() * 2 - 1) * vary);
      const ctx = sfxContext();
      if (!ctx) return;
      const buf = sfxBank[name];
      if (!buf) { synthSfx(name, rate); return; }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      const g = ctx.createGain();
      g.gain.value = (o.gain === undefined ? 1.0 : o.gain) * (1 + (Math.random() * 2 - 1) * 0.10);
      src.connect(g); g.connect(sfxMaster);
      src.start();
    }

    // The three theme-independent UI sounds, served as static files from sounds/ rather than
    // generated per run. Fetched once and decoded into the same bank, so they play through
    // playSfx like everything else. A 404 (or a checkout without the files) just leaves them
    // absent, and the procedural bank covers them.
    const UI_SOUNDS = ['start', 'button', 'end', 'ready'];
    // The sting that plays the instant the dungeon opens, on a first entry and on a restart
    // from the death box alike. Lowered 15% from full - it was landing louder than the bed
    // it hands off to.
    const START_STING_GAIN = 0.85;
    function loadUiSounds() {
      const ctx = sfxContext();
      if (!ctx) return;
      UI_SOUNDS.forEach(name => {
        if (sfxBank[name]) return;
        fetch(`${SERVER_URL}/sounds/${name}.wav`)
          .then(r => (r.ok ? r.arrayBuffer() : Promise.reject()))
          .then(ab => ctx.decodeAudioData(ab, buf => { sfxBank[name] = buf; }, () => {}))
          .catch(() => { /* falls back to synthSfx */ });
      });
    }

    // An AudioContext created outside a user gesture starts suspended, and resume() only
    // takes inside one. enterDungeon can be reached without a click (the "enter when done
    // loading" checkbox fires it from the poll timer), so rather than relying on any single
    // button, unlock on the first gesture of any kind. Once is enough for the session.
    ['pointerdown', 'keydown'].forEach(evt => {
      window.addEventListener(evt, () => {
        sfxContext(); loadUiSounds(); loadMenuMusic(); loadScreenMusic('loading');
      }, { once: true, capture: true });
    });

    // One delegated click for every Win95 button, rather than a listener per control.
    // Excluded: the D-pad (its buttons already produce a footstep or a wall thud) and the
    // battle action bar (already a swing or a block), where a click on top would double up.
    document.addEventListener('click', (ev) => {
      const btn = ev.target.closest && ev.target.closest('.win95-btn');
      if (!btn) return;
      if (btn.classList.contains('dpad-btn')) return;
      if (btn.closest('#battleActionBar')) return;
      playSfx('button', { vary: 0.03, gain: 0.5 });
    }, true);
    // HUD portrait expressions, in PORTRAIT_FRAME_NAMES order: idle, attack, block, hurt.
    let playerFaceFrames = [];
    let rig = { swordX: 24, swordY: -30, shieldX: -28, shieldY: -32 };

    let MAP = [];
    let MAP_WIDTH = 0;
    let MAP_HEIGHT = 0;
    let visitedTiles = new Set();
    let passagesList = [];
    let lanternList = [];
    // Locked gates on the single start->exit path, and the wall switches that open them.
    // doorList:   [{ x, y, index, opened }]  - x,y is a former connector tile now set to MAP 3
    // switchList: [{ x, y, cellX, cellY, doorIndex, on }] - x,y is a wall tile set to MAP 4/5,
    //             cellX,cellY the floor tile the player stands on to face it.
    // Built by placeGatesAndSwitches() during maze generation; guaranteed solvable.
    let doorList = [];
    let switchList = [];
    // Roaming foes, scattered over the walkable tiles at generation time and drawn in the 3D
    // view as floating billboards (see drawWorldEnemies). Stepping onto one starts its battle;
    // winning clears `alive` and the marker stops being drawn.
    //   [{ x, y, variant, alive, phase }]   phase de-syncs each marker's hover bob.
    let enemyMarkers = [];
    // The marker whose battle is currently running, so the win can retire the right one.
    let activeMarker = null;
    let exitRoom = { x: 5, y: 5 };
    let startRoom = { x: 1, y: 1 };
    let zBuffer = new Float64Array(screenWidth);

    let activeMode = 'v6_krea';
    let currentThemeName = "Windows 95";
    let totalMoves = 0;
    let queuedAction = null;

    // The dungeon exactly as the player entered it - MAP tiles, the door/switch latches, the
    // walkable-tile list and the spawn pose, plus the asset bundle so its music can restart.
    // Captured once by enterDungeon(); restartDungeon() rolls the whole run back to it from the
    // death screen without regenerating anything.
    let dungeonSnapshot = null;

    const DIRS = ['NORTH', 'EAST', 'SOUTH', 'WEST'];
    const DIR_VECS = [
      { dx: 0, dy: -1 }, // 0: NORTH
      { dx: 1, dy: 0 },  // 1: EAST
      { dx: 0, dy: 1 },  // 2: SOUTH
      { dx: -1, dy: 0 }  // 3: WEST
    ];

    function dirToAngle(dirIndex) {
      if (dirIndex === 0) return -Math.PI / 2; // NORTH
      if (dirIndex === 1) return 0;            // EAST
      if (dirIndex === 2) return Math.PI / 2;  // SOUTH
      if (dirIndex === 3) return Math.PI;      // WEST
      return 0;
    }

    let player = {
      gridX: 1,
      gridY: 1,
      posX: 1.5,
      posY: 1.5,
      angle: 0,
      dirIndex: 1,
      isAnimating: false
    };

    // ==========================================
    // WINDOW BUTTONS & FULLSCREEN HANDLERS
    // ==========================================
    function toggleFullscreen() {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => console.warn(err));
        btnMaximize.textContent = "❐";
      } else {
        document.exitFullscreen().catch(err => console.warn(err));
        btnMaximize.textContent = "□";
      }
    }

    btnMaximize.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', () => {
      btnMaximize.textContent = document.fullscreenElement ? "❐" : "□";
    });

    function openSetupScreen() {
      screenGame.classList.add('hidden');
      victoryModal.classList.add('hidden');
      if (defeatModal) defeatModal.classList.add('hidden');
      screenSetup.classList.remove('hidden');
      if (titleButtons) titleButtons.classList.remove('hidden');
      appContainer.className = 'win95-box p-1 text-black mode-setup w-full';
      returnToMenuMusic();     // win, lose, or quit - the dungeon's music stops, menu fades in
    }

    btnClose.addEventListener('click', () => {
      if (!screenGame.classList.contains('hidden')) {
        if (confirm("Would you like to create a new dungeon?")) openSetupScreen();
      } else {
        openSetupScreen();
      }
    });

    btnPlayAgain.addEventListener('click', openSetupScreen);

    function setDifficulty(id) {
      if (!DIFFICULTIES[id]) id = 'medium';
      selectedDifficulty = id;
      gridDesc.textContent = DIFFICULTIES[id].desc;
      difficultyRow.querySelectorAll('.difficulty-btn').forEach((btn) => {
        btn.classList.toggle('is-selected', btn.dataset.difficulty === id);
      });
    }

    difficultyRow.addEventListener('click', (e) => {
      const btn = e.target.closest('.difficulty-btn');
      if (btn) setDifficulty(btn.dataset.difficulty);
    });
    setDifficulty(selectedDifficulty);

    btnSettings.addEventListener('click', () => modalSettings.classList.remove('hidden'));
    btnCloseSettings.addEventListener('click', () => modalSettings.classList.add('hidden'));
    btnSaveSettings.addEventListener('click', () => modalSettings.classList.add('hidden'));

    // Each quick idea fills in the whole setup - dungeon look plus the player, weapon and
    // enemy - so one click gives a coherent theme instead of just a wall style. Fields that
    // are locked to an uploaded image are left alone.
    const PRESET_IDEAS = {
      // "stick of computer RAM", not "stick of ram": lowercase "ram" is a male sheep, and the
      // generator drew exactly that - a brawny humanoid brute. Verified side by side on the
      // same prompt: "stick of ram" -> an animal, "stick of computer RAM" -> a DDR module.
      'Windows 95 3D maze': { player: 'guy in a shirt and tie with thick glasses', weapon: 'computer keyboard',     enemy: 'stick of computer RAM' },
      'Deep Forest': { player: 'druid in leaf armor',                        weapon: 'living oak staff',              enemy: 'moss-covered dire bear' },
      'Cyber Neon':  { player: 'chrome street samurai in a neon jacket',      weapon: 'glowing plasma katana',        enemy: 'rogue security drone' },
      'Mossy Stone': { player: 'lichen-cloaked stone knight',                weapon: 'moss-covered stone warhammer', enemy: 'crumbling gargoyle golem' },
      'Candy Cane':  { player: 'gingerbread paladin with frosting armor',    weapon: 'peppermint candy cane staff',  enemy: 'gummy bear' },
      'Tacos':       { player: 'masked luchador chef',                       weapon: 'sizzling cast-iron skillet',   enemy: 'taco' },
      'Haunted Manor':   { player: 'victorian ghost hunter',                  weapon: 'silver-tipped cane',           enemy: 'poltergeist in a torn dress' },
      'Volcanic Depths': { player: 'ash-scarred fire dwarf in obsidian mail', weapon: 'molten iron greataxe',         enemy: 'lumbering magma golem' },
      'Sunken Ruins':    { player: 'coral-armored deep diver',                weapon: 'barnacled bronze trident',     enemy: 'tentacled kraken spawn' },
      "Pharaoh's Tomb":  { player: 'bandaged tomb raider in linen wraps',     weapon: 'golden khopesh sword',         enemy: 'shambling scarab-covered mummy' },
    };

    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.getAttribute('data-val');
        wallPromptInput.value = val.toLowerCase();
        const idea = PRESET_IDEAS[val];
        if (!idea) return;
        if (playerPromptInput && !playerPromptInput.disabled) playerPromptInput.value = idea.player;
        if (weaponPromptInput && !weaponPromptInput.disabled) weaponPromptInput.value = idea.weapon;
        if (enemyPromptInput && !enemyPromptInput.disabled) enemyPromptInput.value = idea.enemy;
      });
    });

    // ==========================================
    // VALBRACE REAL-TIME COMBAT ENGINE (v5)
    // ==========================================
    const doomFaceCanvas = document.getElementById('doomFaceCanvas');
    const doomFaceCtx = doomFaceCanvas ? doomFaceCanvas.getContext('2d') : null;
    const battleActionBar = document.getElementById('battleActionBar');
    // The battle bar and the D-pad share one slot in the controls panel - exactly one of them
    // is on screen at a time, which keeps the sidebar (and so the window) a fixed height.
    const dpadGrid = document.getElementById('dpadGrid');
    const battleModeBadge = document.getElementById('battleModeBadge');
    // Replaced with the story's hero name as soon as the crawl lands; falls back to the
    // generic label for legacy modes that never generate a story.
    const heroStatusLabel = document.getElementById('heroStatusLabel');
    const HERO_STATUS_DEFAULT = 'WARRIOR STATUS:';

    function applyHeroStatusLabel() {
      if (!heroStatusLabel) return;
      const hero = (dungeonStory && dungeonStory.hero || '').trim();
      heroStatusLabel.textContent = hero ? (hero.toUpperCase() + ':') : HERO_STATUS_DEFAULT;
    }

    const playerHpBar = document.getElementById('playerHpBar');
    const playerHpText = document.getElementById('playerHpText');
    const playerStmBar = document.getElementById('playerStmBar');
    const playerStmText = document.getElementById('playerStmText');
    const playerXpBar = document.getElementById('playerXpBar');
    const playerXpText = document.getElementById('playerXpText');
    const playerLevelBadge = document.getElementById('playerLevelBadge');
    const encounterBadge = document.getElementById('encounterBadge');
    const controlsHeader = document.getElementById('controlsHeader');

    const levelUpModal = document.getElementById('levelUpModal');
    const levelUpLevelText = document.getElementById('levelUpLevelText');
    const levelUpChoices = document.getElementById('levelUpChoices');

    // ==========================================
    // LEVELLING
    // ==========================================
    // The base bars every run starts from. playerMaxHp / playerMaxStm are BASE + the bonuses
    // banked by SURVIVAL / STAMINA picks, recomputed by applyProgressionStats() - so resetting
    // progression really does put the bars back where a fresh hero starts.
    const BASE_MAX_HP = 100;
    const BASE_MAX_STM = 100;

    // What each foe is worth. Roughly proportional to how long it takes to put down: the boss
    // has 2.4x the walker's HP and hits hardest, the flyer spends most of the fight out of
    // reach. A maze holds ~4-14 markers (see placeEnemyMarkers), so clearing a whole dungeon
    // is worth ~150-350 XP - three to four levels.
    // The two pack foes are worth less each because you fight three / two of them: a swarm
    // pays 3x10 = 30 and a wing 2x12 = 24. The swarm sits above the walker it is built from
    // because it hits about 1.6x as hard and has more HP between the three of them; the wing
    // sits BELOW the flyer it is built from, despite being two creatures, because its circle
    // hands the player an opening roughly every 1.6s against the flyer's 2.9s and it goes
    // down in a fifth of the time.
    const ENEMY_XP = { walker: 22, flyer: 28, boss: 60, swarmer: 10, circler: 12 };

    // 40 to reach level 2, then 30 more each time: 40 / 70 / 100 / 130... Two walkers make the
    // first level, and the curve outruns a single dungeon's supply by about level 5.
    function xpForLevel(level) { return 40 + (level - 1) * 30; }

    const LEVEL_GAINS = { strength: 4, stamina: 15, survival: 20 };
    // Every level also patches the hero up, whichever path they take. Without it the run is
    // decided by the first two fights - there is no other healing in the dungeon.
    const LEVEL_HEAL_FRAC = 0.4;

    const progression = {
      level: 1,
      xp: 0,
      xpToNext: xpForLevel(1),
      bonusAtk: 0,
      bonusHp: 0,
      bonusStm: 0,
      pendingLevels: 0,   // levels banked but not yet spent; the modal reopens per level
      choiceIndex: 0      // which option the keyboard cursor is on
    };

    const LEVEL_CHOICE_KEYS = ['strength', 'stamina', 'survival'];
    let levelUpOpen = false;
    // How far the dungeon's bed drops under the level-up loop. Ducked rather than silenced, so
    // the run is still audibly going on underneath the choice.
    const LEVELUP_DUCK = 0.18;
    // Tracks whether the music swap has happened, separately from levelUpOpen: two banked
    // levels re-open the box without ever closing it, and the loop must not restart between
    // them (playScreenMusic is idempotent, but the duck ramp would retrigger).
    let levelUpMusicWasOpen = false;

    // ---- Progression -------------------------------------------------------

    // The bars are derived, never edited in place: max = base + banked bonuses. Anything that
    // changes a bonus (a level-up pick) or clears them (a new dungeon) calls this.
    function applyProgressionStats() {
      combatState.playerMaxHp = BASE_MAX_HP + progression.bonusHp;
      combatState.playerMaxStm = BASE_MAX_STM + progression.bonusStm;
      combatState.playerHp = Math.min(combatState.playerHp, combatState.playerMaxHp);
      combatState.playerStm = Math.min(combatState.playerStm, combatState.playerMaxStm);
    }

    function updateProgressionHUD() {
      if (playerLevelBadge) playerLevelBadge.textContent = `LV ${progression.level}`;
      if (playerXpBar) {
        playerXpBar.style.width = `${Math.min(100, (progression.xp / progression.xpToNext) * 100)}%`;
      }
      if (playerXpText) playerXpText.textContent = `${progression.xp}/${progression.xpToNext}`;
      if (encounterBadge) {
        const left = enemyMarkers.filter(m => m.alive).length;
        encounterBadge.textContent = left ? `Foes: ${left}` : 'Foes: cleared';
      }
    }

    function resetProgression() {
      progression.level = 1;
      progression.xp = 0;
      progression.xpToNext = xpForLevel(1);
      progression.bonusAtk = 0;
      progression.bonusHp = 0;
      progression.bonusStm = 0;
      progression.pendingLevels = 0;
      progression.choiceIndex = 0;
      closeLevelUpModal();
      applyProgressionStats();
      updateProgressionHUD();
    }

    // Award a kill's XP and bank any levels it crossed. A single boss can span two thresholds,
    // so this loops - and pendingLevels means the modal is shown once PER level rather than
    // silently swallowing the second one.
    function grantXp(amount) {
      if (!amount) return;
      progression.xp += amount;
      while (progression.xp >= progression.xpToNext) {
        progression.xp -= progression.xpToNext;
        progression.level++;
        progression.xpToNext = xpForLevel(progression.level);
        progression.pendingLevels++;
      }
      updateProgressionHUD();
      if (progression.pendingLevels > 0) openLevelUpModal();
    }

    function openLevelUpModal() {
      if (!levelUpModal || progression.pendingLevels <= 0) return;
      levelUpOpen = true;
      releaseHeldKeys();          // a held guard must not drain stamina behind the modal
      progression.choiceIndex = 0;
      if (levelUpLevelText) {
        // The level being SPENT, not necessarily the one just reached - two banked levels are
        // taken one at a time, oldest first.
        const spending = progression.level - progression.pendingLevels + 1;
        levelUpLevelText.textContent = `Level ${spending}`;
      }
      const sTxt = document.getElementById('levelUpStrengthText');
      const tTxt = document.getElementById('levelUpStaminaText');
      const vTxt = document.getElementById('levelUpSurvivalText');
      if (sTxt) sTxt.textContent = `+${LEVEL_GAINS.strength} attack damage`;
      if (tTxt) tTxt.textContent = `+${LEVEL_GAINS.stamina} max stamina`;
      if (vTxt) vTxt.textContent = `+${LEVEL_GAINS.survival} max health`;
      levelUpModal.classList.remove('hidden');
      syncLevelUpSelection();
      playSfx('end', { vary: 0, gain: 0.55 });
      // The dungeon's bed steps aside for the level-up loop rather than stopping: this is a
      // pause inside the run, not the end of one, so the explore/battle beds are ducked (and
      // kept running) and brought straight back when the choice is taken. Both calls are
      // no-ops when the loop or the bank never loaded, so a silent run stays silent.
      if (!levelUpMusicWasOpen) {
        levelUpMusicWasOpen = true;
        duckDungeonMusic(LEVELUP_DUCK, 0.35);
        playScreenMusic('levelup');
      }
    }

    function closeLevelUpModal() {
      levelUpOpen = false;
      if (levelUpModal) levelUpModal.classList.add('hidden');
      if (levelUpMusicWasOpen) {
        levelUpMusicWasOpen = false;
        stopScreenMusic(0.5);
        duckDungeonMusic(1, 1.1);
      }
    }

    function syncLevelUpSelection() {
      if (!levelUpChoices) return;
      const btns = levelUpChoices.querySelectorAll('.levelup-choice');
      btns.forEach((b, i) => b.classList.toggle('selected', i === progression.choiceIndex));
    }

    function moveLevelUpSelection(delta) {
      const n = LEVEL_CHOICE_KEYS.length;
      progression.choiceIndex = (progression.choiceIndex + delta + n) % n;
      syncLevelUpSelection();
      playSfx('turn', { gain: 0.4 });
    }

    function applyLevelChoice(kind) {
      if (!levelUpOpen || progression.pendingLevels <= 0) return;
      if (kind === 'strength') progression.bonusAtk += LEVEL_GAINS.strength;
      else if (kind === 'stamina') progression.bonusStm += LEVEL_GAINS.stamina;
      else if (kind === 'survival') progression.bonusHp += LEVEL_GAINS.survival;
      else return;

      progression.pendingLevels--;
      applyProgressionStats();
      // SURVIVAL's new headroom is handed over filled, and every level tops the hero up - see
      // LEVEL_HEAL_FRAC. Stamina refills the same way so the next fight opens with a full bar.
      const heal = Math.round(combatState.playerMaxHp * LEVEL_HEAL_FRAC)
                 + (kind === 'survival' ? LEVEL_GAINS.survival : 0);
      combatState.playerHp = Math.min(combatState.playerMaxHp, combatState.playerHp + heal);
      combatState.playerStm = combatState.playerMaxStm;
      updateProgressionHUD();
      playSfx('button', { vary: 0.05 });

      // A second banked level (a boss can carry the hero across two thresholds) is taken as its
      // own pick, straight away. Re-opening in place rather than closing and re-opening on a
      // timer matters: any gap would unfreeze the dungeon between the two choices.
      if (progression.pendingLevels > 0) {
        openLevelUpModal();
      } else {
        closeLevelUpModal();
        render3D();
      }
    }

    if (levelUpChoices) {
      levelUpChoices.querySelectorAll('.levelup-choice').forEach(btn => {
        btn.addEventListener('click', () => applyLevelChoice(btn.dataset.choice));
      });
    }

    // One gate for every input path - the keyboard handler, the D-pad and the combat buttons
    // all check this, so the level-up box really does stop the game rather than just covering it.
    function inputLocked() {
      return levelUpOpen;
    }

    const btnCombatDodgeL = document.getElementById('btnCombatDodgeL');
    const btnCombatAttack = document.getElementById('btnCombatAttack');
    const btnCombatBlock = document.getElementById('btnCombatBlock');
    const btnCombatDodgeR = document.getElementById('btnCombatDodgeR');

    const keysHeld = {
      left: false,
      right: false,
      block: false
    };


    const combatState = {
      inBattle: false,
      dead: false,              // set by killPlayer(); freezes combat until Rise / new dungeon
      // How many sim ticks the current battle has been running. Drives the entrance: the hero
      // slides up from below the frame while the foe dither-fades in. Both are done, and both
      // fighters unfrozen, at INTRO_TOTAL.
      introFrame: 0,
      pendingXp: 0,             // banked at the kill, paid out when the death fade finishes
      playerHp: 100,
      playerMaxHp: 100,
      playerStm: 100,
      playerMaxStm: 100,
      playerX: 0,
      vx: 0,
      attackFrame: 0,
      maxAttackFrames: 18,
      hurtFrame: 0,
      maxHurtFrames: 24,
      shieldProgress: 0.0,
      combatEffects: [],
      // Every foe on the field. A normal fight holds exactly one entry, and enemies[0] is
      // always the same object as `enemy` below - the lead. The pack variants (swarmer /
      // circler) fill it with 3 / 2 of them. Anything that reads ONE foe (the death epitaph,
      // killPlayer, the name plate) still reads the lead; anything that fights reads the array.
      enemies: [],
      enemy: {
        name: 'NIGHTSTALKER',
        variant: 'walker',
        hp: 100,
        maxHp: 100,
        attackTimer: 110,
        state: 'idle',
        stateTimer: 0,
        x: 0,            // horizontal offset from centre, px
        vx: 0,
        altitude: 0,     // 0 = grounded; >0 = hovering height (flyer)
        swoop: 'none',   // flyer: none | diving | striking | rising
        swoopTimer: 0,
        blockTimer: 0,   // walker: >0 = guarding, the next player strike is largely absorbed
        atkCount: 0,     // boss: swings taken in the current patrol phase (3 -> hunt)
        hunting: false,  // boss: walking the player down instead of drifting left/right
        orbit: 0,        // circler: angle around its holding pattern, radians
        laps: 0,         // circler: full circles flown since its last swoop
        homeX: 0,        // circler: the centre that circle is drawn around
        formOffset: 0,   // swarmer: the spot in the pack it holds, px either side of the player
        deathFade: 0     // >0 once killed: ticks up while the corpse dithers away
      },
      faceState: 'idle',
      faceTimer: 0,
      glanceDir: 0,
      glanceTimer: 60
    };
    // The lead is enemies[0], always - see the comment on the array above.
    combatState.enemies = [combatState.enemy];

    // walker / flyer / boss - one typed enemy idea, three battlefield roles. Stats and AI
    // differ here; the distinct sprites come from the server (bundle.enemy_variants).
    //   heightFrac - target on-screen height as a fraction of the 240px combat canvas.
    //                The boss is pinned near the ceiling: its feet sit at GROUND_Y (165), so
    //                anything above ~0.69 clips off the top of the frame. The size gap is
    //                therefore made by keeping the walker SMALL rather than the boss bigger -
    //                0.44 vs 0.68 is a clear 1.5x, and 106px also matches the ~104px the
    //                original procedural enemy was drawn at.
    //   widthFrac  - hard cap on drawn width as a fraction of the 320px width. Sprites now
    //                fill their generated canvas, so a winged flyer arrives far wider than
    //                it is tall and would otherwise span the whole screen.
    //   cadence    - frames between attacks   telegraph - wind-up lead frames
    // sfxRate pitches every sound this variant causes (hit_enemy, block, death_enemy) - the
    // same three sprites and stats read as one species at three sizes, so the ear does the
    // rest: the flyer sounds small and quick, the boss sounds huge and slow. 1.0 = walker's
    // own recorded pitch, unchanged.
    // canBlock/blockOdds/blockHold: the two foes that fight on the ground guard, and they have
    // a generated block frame to show for it (server ENEMY_VARIANT_FRAMES). The flyer does not
    // - it stays out of reach instead, which is its whole defence, and it has no block frame.
    //
    // blockOdds is rolled ONCE PER FRAME, but only while idle (not mid-attack, wind-up or
    // stagger) and only when no guard is already up, so the raw number is much smaller than
    // the behaviour it produces. Simulated over 10 minutes of combat, guard uptime / guards
    // per minute:
    //   walker  0.006/75  -> 23%, 12.7    now 0.018/90  -> 52%, 23.3
    //   boss    0.004/110 -> 24%,  8.6    now 0.030/150 -> 74%, 19.5
    // Those are upper bounds: the sim does not model the player, and a landed hit always
    // breaks the guard (damage drops to 25% and blockTimer clears), so real uptime is lower.
    // That break is also why even the boss's near-permanent guard costs the player a weakened
    // swing rather than stalling the fight - but it does roughly halve effective DPS on it.
    const ENEMY_VARIANTS = {
      walker: { tag: '',       maxHp: 100, dmg: 16, cadence: 115, telegraph: 30, heightFrac: 0.44, widthFrac: 0.52, fly: false, canBlock: true,  blockOdds: 0.018, blockHold: 90,  slow: false, hover: 0,  sfxRate: 1.00, timid: true },
      flyer:  { tag: 'FLYING ', maxHp: 70,  dmg: 13, cadence: 95,  telegraph: 20, heightFrac: 0.40, widthFrac: 0.66, fly: true,  canBlock: false, blockOdds: 0,     blockHold: 0,   slow: false, hover: 58, sfxRate: 1.35 },
      boss:   { tag: 'DREAD ',  maxHp: 240, dmg: 30, cadence: 160, telegraph: 46, heightFrac: 0.68, widthFrac: 0.78, fly: false, canBlock: true,  blockOdds: 0.030, blockHold: 150, slow: true,  hover: 0,  sfxRate: 0.72, timid: false },

      // --- PACK FOES. Neither one costs a generation: `recolorOf` names the variant whose
      // sprites they borrow and hue/sat is the filter laid over every frame of them (see
      // recolorFrame), so a swarm reads as its own creature drawn in another colour. Their
      // heightFrac/widthFrac are the base variant's x0.7 - the "30% smaller" - and `group` is
      // how many of them spawn at once. `spd` overrides the grounded walk speed.
      //
      //   swarmer  three little walkers, 0.44 -> 0.308 tall. No guard at all (the big one's
      //            block is what makes it a wall; these are meant to be swatted), 38 HP each
      //            against its 100, and they attack constantly - a 70-frame cadence against
      //            the walker's 115, with the three clocks fanned out across one cycle by
      //            initEnemy so the pressure is steady rather than one huge simultaneous hit.
      //            Simulated against a passive player who never moves or guards, all three
      //            in range, that is ~10 HP/s of incoming damage against the lone walker's
      //            ~6 - and each kill takes a third of it away, while the walker's guard (a
      //            swarmer has none) roughly halves what the player deals back to IT. The two
      //            fights end up costing about the same, which is what 38 HP a head and a
      //            6-damage bite are tuned for. They also never break off: `timid` is what
      //            makes the lone walker retreat below 30% HP, and these do not have it.
      //   circler  two small flyers, 0.40 -> 0.28 tall, that hold a circular pattern instead
      //            of the flyer's hover. altitude = hover - sin(orbit) * orbitLift runs
      //            52 +/- 26, so the bottom of every lap sits at 26 - under the 34px reach
      //            cut-off in the player's strike, for roughly a quarter of each circle.
      //            Unlike the flyer, which can only be hit during its own swoop, this one
      //            hands the player a window every lap. After CIRCLER_LAPS circles it breaks
      //            off and dives like a flyer.
      swarmer: { tag: 'RUNT ',      maxHp: 38, dmg: 6,  cadence: 70, telegraph: 16, heightFrac: 0.308, widthFrac: 0.364, fly: false, canBlock: false, blockOdds: 0, blockHold: 0, slow: false, hover: 0,  sfxRate: 1.30, timid: false, spd: 1.15, recolorOf: 'walker', hue: 205, sat: 1.25, group: 3 },
      circler: { tag: 'FLEDGLING ', maxHp: 48, dmg: 12, cadence: 95, telegraph: 20, heightFrac: 0.280, widthFrac: 0.462, fly: true,  canBlock: false, blockOdds: 0, blockHold: 0, slow: false, hover: 52, sfxRate: 1.55, timid: false, recolorOf: 'flyer', hue: 125, sat: 1.30, group: 2, orbitRX: 52, orbitLift: 26, orbitSpeed: 0.055 },
    };
    const ENEMY_VARIANT_KEYS = ['walker', 'flyer', 'boss'];
    // Full circles a circler flies before it commits to a swoop.
    const CIRCLER_LAPS = 3;

    // Hue-rotate a generated sprite into a second creature. A canvas filter applies to the
    // whole draw, so one pass into an offscreen canvas the size of the source gives a frame
    // that is a drop-in for the Image everywhere downstream - provided it also answers to
    // naturalWidth / naturalHeight / complete, which solidContentBox and drawEnemyContent both
    // read off it. Cached per (source frame, filter), and deliberately NOT cached while the
    // source is still decoding: a call made before the data URL finished loading hands back
    // the untinted original and retries on the next frame rather than freezing a blank canvas
    // into the cache for the rest of the run.
    const _recolorCache = new WeakMap();
    function recolorFrame(img, hue, sat) {
      if (!img || !img.complete || !(img.naturalWidth > 0)) return img;
      let perImg = _recolorCache.get(img);
      if (!perImg) { perImg = new Map(); _recolorCache.set(img, perImg); }
      const ck = hue + '|' + sat;
      const hit = perImg.get(ck);
      if (hit) return hit;
      const w = img.naturalWidth, h = img.naturalHeight;
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const cx = cv.getContext('2d');
      // A browser with no canvas-filter support just draws the copy through untinted - the
      // pack still fights at its own size and stats, it simply isn't recoloured.
      cx.filter = `hue-rotate(${hue}deg) saturate(${sat})`;
      cx.drawImage(img, 0, 0, w, h);
      Object.defineProperty(cv, 'naturalWidth', { value: w });
      Object.defineProperty(cv, 'naturalHeight', { value: h });
      Object.defineProperty(cv, 'complete', { value: true });
      perImg.set(ck, cv);
      return cv;
    }

    // The {idle, attack, block} set a variant draws with. Base variants own theirs; a pack foe
    // borrows its base's and recolours every frame of it. Null means the sprite it needs never
    // arrived, which is the caller's cue to fall back to whatever the mode did ship.
    function enemyFramesFor(key) {
      const cfg = ENEMY_VARIANTS[key];
      if (!cfg) return null;
      if (!cfg.recolorOf) {
        const own = enemyVariantImgs[key];
        return (own && own.idle) ? own : null;
      }
      const base = enemyVariantImgs[cfg.recolorOf];
      if (!base || !base.idle) return null;
      const out = {};
      for (const f of Object.keys(base)) out[f] = recolorFrame(base[f], cfg.hue, cfg.sat);
      return out;
    }

    // What a battle with no marker behind it (Space, in testing) rolls, and the pool
    // placeEnemyMarkers scatters. Kept apart from ENEMY_VARIANT_KEYS, which is the
    // "did the bundle ship distinct sprites" check and has to stay the three generated foes.
    const ENEMY_ROLL_KEYS = ['walker', 'flyer', 'boss', 'swarmer', 'circler'];

    // Roll one of the three foes and apply its stats. Called on every battle entry, so during
    // testing you cycle the variants just by leaving and re-entering combat (Space).
    function pickEnemyVariant(forceKey) {
      // Only roll the full set when we actually have distinct sprites for it (v5/v6 krea);
      // other modes ship one enemy, so they stay on the walker.
      const haveVariants = ENEMY_VARIANT_KEYS.filter(k => enemyVariantImgs[k] &&
                                                          enemyVariantImgs[k].idle).length >= 2;
      // A marker asks for the foe it was drawn as, but a mode that shipped one enemy sprite
      // can only field the walker - fighting a "boss" wearing the walker's art (and its 240 HP)
      // would be a bug, not a surprise.
      let key = haveVariants
        ? (forceKey || ENEMY_ROLL_KEYS[Math.floor(Math.random() * ENEMY_ROLL_KEYS.length)])
        : 'walker';
      // A pack foe exists only as a recolour, so it needs the sprite it borrows. Dropping back
      // to that base variant keeps a marker drawn as a swarm from arriving as three foes with
      // no art, at the cost of it arriving as the one big foe it was recoloured from.
      if (ENEMY_VARIANTS[key] && ENEMY_VARIANTS[key].recolorOf && !enemyFramesFor(key)) {
        key = ENEMY_VARIANTS[key].recolorOf;
      }
      const cfg = ENEMY_VARIANTS[key] || ENEMY_VARIANTS.walker;
      const count = Math.max(1, cfg.group || 1);
      const name = enemyDisplayName(key, cfg);

      // The lead is REUSED, never replaced: killPlayer, deathEpitaph and
      // resetCombatForNewDungeon all hold combatState.enemy directly, so enemies[0] has to
      // stay that same object. The rest of a pack are shallow clones of it.
      const pack = [];
      for (let i = 0; i < count; i++) {
        const e = (i === 0) ? combatState.enemy : Object.assign({}, combatState.enemy);
        initEnemy(e, key, cfg, i, count);
        e.name = name;
        pack.push(e);
      }
      combatState.enemies = pack;

      // Only swap the active sprite when we have a real per-variant set; otherwise leave
      // whatever the bundle loaded (e.g. v3/v4's 3-frame idle/attack/hurt enemy). A pack parks
      // its BASE frames here - the recolour is done per draw by enemyFramesFor, so a sprite
      // that was still decoding at this point still comes out tinted once it lands.
      const set = enemyVariantImgs[cfg.recolorOf || key];
      if (set && set.idle && haveVariants) {
        enemyFrames = set;
        enemySpriteFrames = [set.idle];
      }
      return key;
    }

    // Each foe is its own species with its own invented name ("Gravewing Shrike"), so use that
    // when the server sent one - no "FLYING " tag, because a flyer that was designed to fly is
    // not a tagged version of the walker.
    // Without them (older bundle, or the naming call failed and the three were derived from one
    // sprite) fall back to the tag + the story's common foe name, with the boss taking the
    // story's champion title so the crawl text and the health bar agree:
    // "THE HORDE", "FLYING THE HORDE", "DREAD THE OVERCLOCKED".
    // A pack foe never has a generated name of its own - it wears its base variant's name under
    // its own tag, which is exactly what it looks like: "RUNT GRAVEWING SHRIKE".
    function enemyDisplayName(key, cfg) {
      if (cfg.recolorOf) {
        const baseName = (enemyVariantNames && enemyVariantNames[cfg.recolorOf] || '').trim()
          || (enemyStyleName || 'nightstalker');
        return (cfg.tag + baseName).toUpperCase();
      }
      const ownName = (enemyVariantNames && enemyVariantNames[key] || '').trim();
      const name = ownName || (key === 'boss'
        ? (enemyBossName || (cfg.tag + (enemyStyleName || 'nightstalker')))
        : (cfg.tag + (enemyStyleName || 'nightstalker')));
      return name.toUpperCase();
    }

    // Put one foe on the field. `i` / `count` are its place in the pack, and everything they
    // touch is there to stop a pack behaving as one creature: the attack clocks are fanned out
    // across a full cadence so three swarmers never swing on the same frame, the spawn x is
    // spread across the arena, and each circler starts a lap-fraction round its own circle so
    // two of them are never over the same spot.
    function initEnemy(e, key, cfg, i, count) {
      e.variant = key;
      e.maxHp = cfg.maxHp;
      e.hp = cfg.maxHp;
      e.state = 'idle';
      e.stateTimer = 0;
      e.attackTimer = cfg.cadence + Math.round((cfg.cadence * i) / count);
      e.x = count > 1 ? (i - (count - 1) / 2) * 56 : 0;
      // Boss only - the walker recomputes vx every frame from where the player is standing.
      e.vx = cfg.slow ? 0.5 : 0;
      // Boss attack rhythm - see the grounded-AI block: three patrol swings, then a hunt.
      e.atkCount = 0;
      e.hunting = false;
      e.altitude = cfg.hover;
      e.swoop = 'none';
      e.swoopTimer = cfg.fly ? 90 : 0;
      e.blockTimer = 0;
      e.deathFade = 0;
      // Circler: half a circle apart, around a centre at its own spawn x, so two of them are
      // on opposite sides of their patterns and the player never faces both low points at once.
      e.orbit = (Math.PI * 2 * i) / count;
      e.laps = 0;
      e.homeX = e.x;
      // Where in the pack a swarmer tries to stand, relative to the player. Kept inside the
      // 44px dodge window in landEnemyStrike, so standing still really does let all three
      // connect - stepping aside is what shakes the flankers off.
      e.formOffset = count > 1 ? (i - (count - 1) / 2) * 30 : 0;
    }

    // How the entrance plays, in sim ticks. The hero slides up into frame first; the foe
    // starts materialising a few ticks later and takes longer, so it is still resolving out of
    // the dark when the player has landed. Neither side may act until INTRO_TOTAL.
    const INTRO_SLIDE_FRAMES = 26;    // hero's rise from below the frame
    const INTRO_SLIDE_DIST = 170;     // px below the canvas the hero starts at
    const INTRO_FADE_DELAY = 7;       // ticks before the foe begins to appear
    const INTRO_FADE_FRAMES = 34;     // ticks the foe's dither-in takes
    const INTRO_TOTAL = INTRO_FADE_DELAY + INTRO_FADE_FRAMES;
    // How long a corpse takes to dissolve, plus the beat held after it is gone before the
    // dungeon comes back.
    const DEATH_FADE_FRAMES = 40;
    const DEATH_FADE_HOLD = 20;

    function toggleBattleMode(forceState, forceVariant) {
      if (typeof forceState === 'boolean') {
        combatState.inBattle = forceState;
      } else {
        combatState.inBattle = !combatState.inBattle;
      }
      setMusicMode(combatState.inBattle);

      if (combatState.inBattle) {
        if (battleModeBadge) {
          battleModeBadge.textContent = "BATTLE";
          battleModeBadge.className = "text-[9px] font-bold px-1.5 py-0.2 rounded bg-red-600 text-white animate-pulse";
        }
        if (battleActionBar) battleActionBar.classList.remove('hidden');
        // The D-pad's arrows still called moveForward/rotate mid-fight, walking the player
        // around behind the combat view. Swapping it out for the combat buttons settles that
        // and costs no height, since the two grids are the same size.
        if (dpadGrid) dpadGrid.classList.add('hidden');
        if (controlsHeader) controlsHeader.textContent = "COMBAT: A/D Strafe, Z Strike, X Block";

        combatState.playerX = 0;
        combatState.vx = 0;
        combatState.attackFrame = 0;
        combatState.hurtFrame = 0;
        combatState.shieldProgress = 0;
        // Runs the entrance and, until it finishes, freezes both fighters - see combatTick.
        combatState.introFrame = 0;
        combatState.pendingXp = 0;

        // The foe the marker was drawn as; a battle started any other way still rolls at random.
        pickEnemyVariant(forceVariant);

        const packN = combatState.enemies.length;
        showFloatingCombatText(packN > 1 ? `${combatState.enemy.name} x${packN} APPROACH!`
                                        : `${combatState.enemy.name} APPROACHES!`,
          160, 80, "#facc15");
      } else {
        if (battleModeBadge) {
          battleModeBadge.textContent = "EXPLORATION";
          battleModeBadge.className = "text-[9px] font-bold px-1.5 py-0.2 rounded bg-slate-300 text-slate-800";
        }
        if (battleActionBar) battleActionBar.classList.add('hidden');
        if (dpadGrid) dpadGrid.classList.remove('hidden');
        if (controlsHeader) controlsHeader.textContent = "CONTROLS (Space: Use):";
        combatState.introFrame = 0;
        // Hiding the action bar mid-press means the Block button never receives its pointerup or
        // pointerleave, so keysHeld.block would stay stuck on - and a stuck block drains stamina to
        // 2 and then blocks its own regen forever (see the regen guard in the combat loop).
        releaseHeldKeys();
      }
      render3D();
    }

    // Fraction of the foe's pixels currently drawn: dithers up over the entrance, holds at 1
    // through the fight, dithers back down as the corpse dissolves. 0 means it is gone.
    function enemyVisibility(which) {
      const e = which || combatState.enemy;
      if (e.deathFade > 0) {
        return Math.max(0, 1 - (e.deathFade - 1) / DEATH_FADE_FRAMES);
      }
      if (combatState.introFrame >= INTRO_TOTAL) return 1;
      return Math.max(0, Math.min(1, (combatState.introFrame - INTRO_FADE_DELAY) / INTRO_FADE_FRAMES));
    }

    // Both fighters are held still until the entrance has played out.
    function battleReady() {
      return combatState.inBattle && combatState.introFrame >= INTRO_TOTAL;
    }

    // Walk onto a marker -> its fight begins. The marker is remembered so the win retires the
    // right one; a loss leaves it standing, so a restarted run has to face it again.
    function startEncounter(marker) {
      if (!marker || !marker.alive) return;
      if (combatState.inBattle || combatState.dead || inputLocked()) return;
      activeMarker = marker;
      queuedAction = null;              // a buffered step must not fire behind the duel
      toggleBattleMode(true, marker.variant);
    }

    function checkEncounterAtPlayer() {
      if (combatState.inBattle || combatState.dead || inputLocked()) return;
      const m = enemyMarkers.find(k => k.alive && k.x === player.gridX && k.y === player.gridY);
      if (m) startEncounter(m);
    }

    // The corpse has finished dissolving: retire the marker, hand the dungeon back, and pay out
    // the XP - which is what may raise the level-up box over the corridor.
    function finishEncounterVictory() {
      const xp = combatState.pendingXp;
      combatState.pendingXp = 0;
      if (activeMarker) activeMarker.alive = false;
      activeMarker = null;
      toggleBattleMode(false);
      updateProgressionHUD();
      drawMinimap();
      grantXp(xp);
    }

    // Any held input has to be dropped whenever the player stops actively driving the game, or a
    // key that never got its keyup survives into the next dungeon.
    function releaseHeldKeys() {
      keysHeld.left = false;
      keysHeld.right = false;
      keysHeld.block = false;
    }

    // Twenty ways to say the run ended. {hero} / {area} / {enemy} are filled from the current
    // story and foe when the player goes down - see deathEpitaph().
    const DEATH_MESSAGES = [
      "{hero} fell in {area}, cut down by the {enemy}.",
      "The {enemy} stands over {hero}'s body. {area} claims another.",
      "Here lies {hero}, who thought {area} could be tamed. The {enemy} knew better.",
      "{area} swallowed {hero} whole. The {enemy} barely slowed to feed.",
      "{hero}'s torch went out in {area}. The {enemy} did the rest.",
      "They'll tell stories in {area} about the day the {enemy} broke {hero}.",
      "{hero} came to {area} chasing glory and found the {enemy} instead.",
      "No one will find {hero} in {area}. The {enemy} made sure of that.",
      "The {enemy} had already forgotten {hero}'s name before it left {area}.",
      "{hero} bled out on the cold stone of {area}, the {enemy} already turning away.",
      "{area} has a new decoration: whatever the {enemy} left of {hero}.",
      "{hero} raised a shield. The {enemy} raised the stakes. {area} kept the difference.",
      "Somewhere far from {area}, someone still waits for {hero}. The {enemy} isn't sorry.",
      "The {enemy} has killed better than {hero} in {area}, but not many.",
      "{hero} took one wrong step in {area}. The {enemy} took everything else.",
      "Last line of {hero}'s journal: 'The {area} is quiet. I think the {enemy}—'",
      "The {enemy} of {area} adds {hero} to a very long list.",
      "{hero} died as they lived: underprepared, and in {area}. The {enemy} obliged.",
      "{area} did not mourn {hero}. Neither did the {enemy}.",
      "The {enemy} howled through {area}. {hero} did not answer.",
    ];

    function deathEpitaph() {
      const hero = (dungeonStory && dungeonStory.hero || '').trim() || 'The warrior';
      const area = (dungeonStory && dungeonStory.location || '').trim() || 'this place';
      const enemy = (combatState.enemy && combatState.enemy.name || '').trim() || 'beast';
      const line = DEATH_MESSAGES[Math.floor(Math.random() * DEATH_MESSAGES.length)];
      return line.replace(/\{hero\}/g, hero).replace(/\{area\}/g, area).replace(/\{enemy\}/g, enemy);
    }

    // Player defeat. Until this existed playerHp simply floored at 0 in landEnemyStrike and the
    // fight carried on, so there was no moment for a death sound to belong to.
    function killPlayer() {
      if (combatState.dead) return;      // several strikes can resolve on the same frame
      combatState.dead = true;
      playSfx('death_player');
      // Drop the foes back to a neutral pose so the celebration hop isn't frozen mid-swing.
      for (const e of combatState.enemies) {
        e.state = 'idle';
        e.stateTimer = 0;
        e.blockTimer = 0;
      }
      combatState.hurtFrame = 1;
      combatState.faceState = 'hurt';
      combatState.faceTimer = 999;
      releaseHeldKeys();                 // a held block must not survive into the modal
      // Swap the pulsing "BATTLE TIME" badge for the verdict. resetCombatForNewDungeon()
      // still runs toggleBattleMode(false) on restart/new-dungeon (inBattle is never cleared
      // here), so this clears itself back to "EXPLORATION TIME" then.
      if (battleModeBadge) {
        battleModeBadge.textContent = "YOU DIED";
        battleModeBadge.className = "text-[9px] font-bold px-1.5 py-0.2 rounded bg-red-900 text-white";
      }
      if (deadMovesCount) deadMovesCount.textContent = totalMoves;
      if (defeatText) {
        defeatText.textContent = deathEpitaph();
      }
      // The run's own explore/battle bed has no business under a death box; the death loop
      // takes the screen instead and holds until the player restarts (stopScreenMusic) or
      // quits out to the menu (returnToMenuMusic).
      fadeOutDungeonMusic(0.6);
      // A beat before the box, so the death cry and the hurt frame land first.
      setTimeout(() => {
        if (defeatModal) defeatModal.classList.remove('hidden');
        playScreenMusic('death');
      }, 700);
    }

    // Death-screen "Restart Dungeon": roll the whole run back to the instant the player entered
    // - same maze, same gates (re-locked), same spawn - with bars refilled, the step counter
    // zeroed and the dungeon's music restarted from the top. No regeneration, so it's instant.
    // Falls back to the setup screen if there's somehow no snapshot to restore.
    function restartDungeon() {
      if (!dungeonSnapshot) { openSetupScreen(); return; }

      if (defeatModal) defeatModal.classList.add('hidden');
      if (victoryModal) victoryModal.classList.add('hidden');

      // Maze back to its start-of-run shape: closed doors (MAP 3), un-thrown switches (MAP 4),
      // and the walkable-tile list without any tiles a since-opened door had added.
      MAP = dungeonSnapshot.map.map(row => row.slice());
      passagesList = dungeonSnapshot.passages.map(p => ({ x: p.x, y: p.y }));
      doorList = dungeonSnapshot.doors.map(d => ({ ...d }));
      switchList = dungeonSnapshot.switches.map(s => ({ ...s }));
      // Every foe back on its tile, alive again - the same maze means the same fights, and a
      // restart that kept the cleared markers would hand the player a walk to the exit.
      enemyMarkers = (dungeonSnapshot.enemies || []).map(m => ({ ...m }));

      // Spawn pose (same object - other code closes over `player`).
      Object.assign(player, dungeonSnapshot.player);
      player.isAnimating = false;

      // Exploration progress.
      visitedTiles.clear();
      visitedTiles.add(`${player.gridX},${player.gridY}`);
      totalMoves = 0;
      queuedAction = null;
      if (mapProgressBadge) {
        mapProgressBadge.textContent = `${visitedTiles.size}/${passagesList.length} Tiles`;
      }

      // Combat: the same full reset a brand new dungeon gets - full HP/stamina, fresh foe roll,
      // battle chrome cleared, held keys released, `dead` flag lifted.
      resetCombatForNewDungeon();

      // Music from the top: the death loop that was scoring the box gives way, and
      // loadMusicBank tears down the running explore/battle loops and starts them fresh.
      // playSfx('start') is the same sting enterDungeon plays on entry.
      stopScreenMusic();
      loadMusicBank(dungeonSnapshot.bundle && dungeonSnapshot.bundle.music);
      playSfx('start', { vary: 0, gain: START_STING_GAIN });

      render3D();
      drawMinimap();
      updateHUD();
    }

    if (btnRestartDungeon) btnRestartDungeon.addEventListener('click', restartDungeon);
    if (btnDeadNewDungeon) btnDeadNewDungeon.addEventListener('click', openSetupScreen);

    // Full combat reset for a brand new dungeon. Without this, stamina (and HP, and any in-flight
    // attack/hurt frames) carried over from the previous dungeon - so a run started while blocking
    // or mid-fight began the next dungeon at near-zero stamina.
    function resetCombatForNewDungeon() {
      // Go through toggleBattleMode rather than just clearing the flag, so the badge, action bar,
      // controls header and Battle/Flee button all return to exploration state too - otherwise the
      // new dungeon starts out of battle but still wearing the "BATTLE TIME" chrome.
      if (combatState.inBattle) toggleBattleMode(false);
      releaseHeldKeys();
      // Levels are a per-run thing: a new dungeon (and a restart, which rolls the run back to
      // its first step) starts the hero at level 1 with the base bars. This has to land BEFORE
      // the refill below, since it is what puts playerMaxHp back to BASE_MAX_HP.
      resetProgression();
      activeMarker = null;
      combatState.introFrame = 0;
      combatState.pendingXp = 0;
      combatState.enemies.forEach(e => { e.deathFade = 0; });
      combatState.playerStm = combatState.playerMaxStm;
      combatState.playerHp = combatState.playerMaxHp;
      combatState.playerX = 0;
      combatState.vx = 0;
      combatState.attackFrame = 0;
      combatState.hurtFrame = 0;
      combatState.faceState = 'idle';   // else a death-frame face lingers ~16s into the next run
      combatState.faceTimer = 0;
      combatState.shieldProgress = 0;
      combatState.combatEffects.length = 0;
      combatState.dead = false;
      if (defeatModal) defeatModal.classList.add('hidden');
      pickEnemyVariant();
    }

    // Alt-tabbing or clicking into a text field while holding X swallows the keyup the same way.
    window.addEventListener('blur', releaseHeldKeys);

    function showFloatingCombatText(text, x, y, color = '#ffffff') {
      combatState.combatEffects.push({
        text: text,
        x: x,
        y: y,
        color: color,
        life: 32,
        maxLife: 32
      });
    }

    function combatAttack() {
      if (combatState.dead || inputLocked()) return;
      // No free swing at a foe that hasn't finished arriving, and none at a corpse.
      if (!battleReady() || !combatState.enemies.some(e => e.hp > 0)) return;
      if (combatState.attackFrame > 0 || combatState.hurtFrame > 0) return;
      if (combatState.playerStm < 30) {
        showFloatingCombatText("NO STAMINA!", 160, 180, "#ef4444");
        return;
      }
      combatState.playerStm = Math.max(0, combatState.playerStm - 30);
      // The swing, on the windup. The impact sound is separate, on frame 7 where the hit
      // actually resolves.
      playSfx('attack');
      combatState.attackFrame = 1;
      combatState.faceState = 'attack';
      combatState.faceTimer = 18;
    }

    if (btnCombatDodgeL) {
      btnCombatDodgeL.addEventListener('pointerdown', (e) => { e.preventDefault(); keysHeld.left = true; });
      btnCombatDodgeL.addEventListener('pointerup', () => { keysHeld.left = false; });
      btnCombatDodgeL.addEventListener('pointerleave', () => { keysHeld.left = false; });
    }
    if (btnCombatDodgeR) {
      btnCombatDodgeR.addEventListener('pointerdown', (e) => { e.preventDefault(); keysHeld.right = true; });
      btnCombatDodgeR.addEventListener('pointerup', () => { keysHeld.right = false; });
      btnCombatDodgeR.addEventListener('pointerleave', () => { keysHeld.right = false; });
    }
    if (btnCombatBlock) {
      btnCombatBlock.addEventListener('pointerdown', (e) => { e.preventDefault(); keysHeld.block = true; });
      btnCombatBlock.addEventListener('pointerup', () => { keysHeld.block = false; });
      btnCombatBlock.addEventListener('pointerleave', () => { keysHeld.block = false; });
    }
    if (btnCombatAttack) {
      btnCombatAttack.addEventListener('pointerdown', (e) => { e.preventDefault(); combatAttack(); });
    }

    // Combat runs on a FIXED timestep, decoupled from how often we actually draw.
    //
    // Every counter below (attackTimer, cadence, telegraph, swoopTimer, attackFrame...) is
    // measured in 1/60s frames and stepped exactly once per combatTick(). That was fine while
    // a 60fps timer drove it, but render3D() is a synchronous software raycaster running in the
    // same callback - the moment it blows the 16.7ms budget the browser coalesces the timer,
    // fewer ticks fire, and every attack window stretches out in real seconds. Which is exactly
    // the "enemies get slower when the FPS drops" bug.
    //
    // So: measure real elapsed milliseconds, bank them, and spend them in whole SIM_STEP chunks.
    // A frame that took 33ms runs two ticks, a frame that took 16ms runs one. The sim holds 60
    // steps per real second regardless of frame rate, and none of the tuning numbers had to move.
    // Whole steps matter - the hit resolution checks `attackFrame === 7` and the wind-up checks
    // `attackTimer === cfg.telegraph`, so counters must never skip a value the way `* delta`
    // scaling would make them.
    const SIM_STEP = 1000 / 60;
    const MAX_SIM_STEPS = 5;
    let simLastTime = performance.now();
    let simAccumulator = 0;

    // Resolve one of an enemy's telegraphed strikes against the player's position and guard.
    // Lifted out of the AI so every foe on the field shares one definition of what a landed
    // blow costs. The popups are nudged towards the striker's own x, so three swarmers landing
    // inside the same second don't stack their text on one spot.
    function landEnemyStrike(e, dmg, dodgeMsg, blockMsg, hitLabel) {
      const tx = 160 + (e.x || 0) * 0.4;
      const isDodged = Math.abs(combatState.playerX - e.x) > 44;
      const isGuarded = combatState.shieldProgress > 0.6;
      if (isDodged) {
        playSfx('miss_player');
        showFloatingCombatText(dodgeMsg, tx, 130, "#38bdf8");
      } else if (isGuarded) {
        playSfx('block');
        showFloatingCombatText(blockMsg, tx, 140, "#a855f7");
        combatState.playerHp = Math.max(1, combatState.playerHp - Math.round(dmg * 0.12));
        // Absorbing a blow on the shield barely dents HP but takes a huge bite of stamina -
        // block too many hits without spacing out and the guard breaks.
        combatState.playerStm = Math.max(0, combatState.playerStm - (dmg * 1.5 + 10));
      } else {
        combatState.playerHp = Math.max(0, combatState.playerHp - dmg);
        combatState.hurtFrame = 1;
        combatState.faceState = 'hurt';
        combatState.faceTimer = 26;
        showFloatingCombatText(`-${dmg} ${hitLabel}`, tx, 160, "#dc2626");
        // The guarded branch above floors HP at 1, so this is the only path to 0.
        if (combatState.playerHp <= 0) killPlayer();
        else playSfx('hit_player');
      }
    }

    // Keep pack members off one another. Three swarmers all steering at the same player would
    // otherwise stack into one silhouette with one hitbox. Half the overlap comes out of each
    // side, so a pushed-apart pair stays centred where it was rather than one shoving the other
    // across the arena, and the result is clamped a little wider than the ±85 patrol range so
    // the outside of a squeezed pack can still be reached.
    const MIN_PACK_GAP = 30;
    function separatePack(e) {
      for (const o of combatState.enemies) {
        if (o === e || o.hp <= 0) continue;
        const d = e.x - o.x;
        const overlap = MIN_PACK_GAP - Math.abs(d);
        if (overlap <= 0) continue;
        const dir = d === 0 ? (Math.random() < 0.5 ? -1 : 1) : (d < 0 ? -1 : 1);
        e.x = Math.max(-92, Math.min(92, e.x + dir * overlap * 0.5));
        o.x = Math.max(-92, Math.min(92, o.x - dir * overlap * 0.5));
      }
    }

    // One foe's turn: three ways of fighting, chosen off its variant config.
    //   circling (circler)     - laps a circle that dips into reach, then breaks off to swoop
    //   airborne (flyer)       - hovers out of reach, then swoops
    //   grounded (walker/boss/ - holds the floor, guards, and closes on the player
    //             swarmer)
    function tickEnemyAI(e) {
      const cfg = ENEMY_VARIANTS[e.variant] || ENEMY_VARIANTS.walker;
      if (e.blockTimer > 0) e.blockTimer--;

      if (cfg.orbitLift) {
        // Circler: instead of the flyer's hover it flies a circle - cos drives the drift across
        // the arena, sin drives the altitude - so it is out of reach over the top of the arc
        // and inside the player's 34px reach at the bottom of it. That is its whole weakness:
        // the flyer can only be hit during its own swoop, this one hands the player a window
        // on every lap. After CIRCLER_LAPS circles it breaks off and dives exactly like a
        // flyer, then slides back into the pattern wherever it ended up.
        if (e.state === 'hurt') {
          e.stateTimer--;
          if (e.stateTimer <= 0 && e.swoop === 'none') e.state = 'idle';
        }
        e.swoopTimer--;
        if (e.swoop === 'none') {
          e.orbit = (e.orbit + cfg.orbitSpeed) % (Math.PI * 2);
          // laps counts CIRCLES FLOWN, fractionally, rather than wraps of e.orbit - the two
          // came apart the moment a circler could rejoin its pattern part-way round (see the
          // 'rising' branch), which made the first lap after a swoop as short as a quarter turn.
          e.laps += cfg.orbitSpeed / (Math.PI * 2);
          e.x = e.homeX + Math.cos(e.orbit) * cfg.orbitRX;
          // Minus sin: the low point of the lap is at orbit = pi/2 and the high point at
          // 3pi/2, running 26..78 against the 34px reach cut-off in the player's strike - so
          // roughly a quarter of every circle has it inside the blade's reach.
          e.altitude = cfg.hover - Math.sin(e.orbit) * cfg.orbitLift;
          if (e.laps >= CIRCLER_LAPS && e.state !== 'hurt') {
            e.laps = 0;
            e.swoop = 'diving'; e.swoopTimer = 24; e.state = 'telegraph';
            showFloatingCombatText("⚠️ IT BREAKS OFF!", 160 + e.x * 0.5, 58, "#fbbf24");
          }
        } else if (e.swoop === 'diving') {
          e.altitude += (0 - e.altitude) * 0.22;
          e.x += (combatState.playerX - e.x) * 0.16;
          if (e.swoopTimer <= 0) {
            e.swoop = 'striking'; e.swoopTimer = 14; e.state = 'attack';
            landEnemyStrike(e, cfg.dmg, "DODGED THE DIVE!", "🛡️ DIVE BLOCKED!", "DIVE!");
          }
        } else if (e.swoop === 'striking') {
          if (e.swoopTimer <= 0) { e.swoop = 'rising'; e.swoopTimer = 26; }
        } else if (e.swoop === 'rising') {
          e.altitude += (cfg.hover - e.altitude) * 0.16;
          if (e.swoopTimer <= 0) {
            e.swoop = 'none'; e.state = 'idle';
            // Rejoin the pattern around where it actually is. Both halves matter: the centre
            // is re-pinned near where it climbed out (clamped so the circle stays on screen),
            // and the ANGLE is solved from its current x - acos gives the two candidates and
            // the 2pi- form picks the upper half of the circle, where sin is negative and the
            // altitude is at or above hover. Snapping orbit to 0 instead would have flung it
            // a full radius sideways on the frame it re-entered the pattern.
            e.homeX = Math.max(-30, Math.min(30, e.x));
            const t = Math.max(-1, Math.min(1, (e.x - e.homeX) / cfg.orbitRX));
            e.orbit = (Math.PI * 2) - Math.acos(t);
            e.laps = 0;
          }
        }
      } else if (cfg.fly) {
        // Flyer: hovers high and out of reach, drifting side to side, until it commits to a
        // swoop - dive to the player, strike, climb back up.
        if (e.state === 'hurt') {
          e.stateTimer--;
          if (e.stateTimer <= 0 && e.swoop === 'none') e.state = 'idle';
        }
        e.swoopTimer--;
        if (e.swoop === 'none') {
          e.x += Math.sin(Date.now() / 620) * 1.3;
          e.altitude = cfg.hover + Math.sin(Date.now() / 300) * 5;
          if (e.swoopTimer <= 0 && e.state !== 'hurt') {
            e.swoop = 'diving'; e.swoopTimer = 26; e.state = 'telegraph';
            showFloatingCombatText("⚠️ SWOOP INCOMING!", 160, 58, "#fbbf24");
          }
        } else if (e.swoop === 'diving') {
          e.altitude += (0 - e.altitude) * 0.22;
          e.x += (combatState.playerX - e.x) * 0.14;
          if (e.swoopTimer <= 0) {
            e.swoop = 'striking'; e.swoopTimer = 14; e.state = 'attack';
            landEnemyStrike(e, cfg.dmg, "DODGED THE SWOOP!", "🛡️ SWOOP BLOCKED!", "SWOOP!");
          }
        } else if (e.swoop === 'striking') {
          if (e.swoopTimer <= 0) { e.swoop = 'rising'; e.swoopTimer = 26; }
        } else if (e.swoop === 'rising') {
          e.altitude += (cfg.hover - e.altitude) * 0.16;
          if (e.swoopTimer <= 0) {
            e.swoop = 'none'; e.swoopTimer = 80 + Math.floor(Math.random() * 60); e.state = 'idle';
          }
        }
      } else {
        // Walker, swarmer & boss: three ways of holding the ground. The walker stalks - it
        // creeps towards wherever the player is standing, and turns tail once it is badly
        // hurt. Its crawl is deliberately far slower than the player's 3.8px/frame strafe, so
        // the 44px dodge window in landEnemyStrike stays winnable - the pressure is that
        // standing still lets it close the gap.
        // The swarmer is that same stalk, quicker and without the nerve to break off, aimed at
        // its own slot in the pack (formOffset) rather than at the player's exact x so three of
        // them arrive spread out instead of single file.
        // The boss alternates instead: it drifts left/right for three haymakers (picking a
        // fresh direction after each), then hunts - steering straight at the player until it
        // lands the next one, then back to the drift. See the attack-resolution block below.
        // Its patrol is also much wider than it used to be. Penned into ±24 it could never
        // reach a player parked at the ±85 strafe limit - the gap stayed over that 44px dodge
        // threshold, so every haymaker scored as a miss and the edge of the arena was a free
        // camp. ±62 closes that, and a hunt gets the walker's full ±85 so following the player
        // means all the way to the wall.
        const range = cfg.slow ? (e.hunting ? 85 : 62) : 85;
        const spd = cfg.spd || (cfg.slow ? 0.5 : 0.9);
        if (e.state !== 'attack' && e.state !== 'telegraph') {
          if (!cfg.slow || e.hunting) {
            const gap = (combatState.playerX + (e.formOffset || 0)) - e.x;
            const toward = gap < 0 ? -1 : 1;
            // Below 30% HP a TIMID foe loses its nerve and backs away instead of closing. Only
            // the lone walker is: the boss never breaks off once it is hunting, and a swarmer
            // is meant to keep coming - three of them peeling away at 11 HP would turn the back
            // half of every swarm fight into a chase.
            const flees = cfg.timid && e.hp <= e.maxHp * 0.3;
            // A hunt closes faster than the patrol drift, but 0.8px/frame is still a fifth of
            // the player's 3.8px strafe - it is outrunnable, just not ignorable.
            e.vx = (flees ? -toward : toward) * (e.hunting ? spd * 1.6 : spd);
            // Don't jitter once it is already standing on its mark.
            if (Math.abs(gap) < 6 && !flees) e.vx = 0;
          }
          e.x += e.vx;
          if (e.x > range) { e.x = range; e.vx = -Math.abs(e.vx); }
          else if (e.x < -range) { e.x = -range; e.vx = Math.abs(e.vx); }
          if (combatState.enemies.length > 1) separatePack(e);
        }

        if (e.state === 'hurt' || e.state === 'attack') {
          e.stateTimer--;
          if (e.stateTimer <= 0) e.state = 'idle';
        } else {
          e.attackTimer--;
          // A grounded foe occasionally raises its guard between attacks (see the player-strike
          // resolution, where e.blockTimer soaks most of a hit). While blockTimer runs, the
          // renderer swaps in that foe's generated block frame. The swarmer has no guard at
          // all - blockOdds 0 - which is most of what makes a pack of them killable.
          if (cfg.canBlock && e.state === 'idle' && e.blockTimer <= 0
              && Math.random() < (cfg.blockOdds || 0)) {
            e.blockTimer = cfg.blockHold || 75;
            showFloatingCombatText("ENEMY GUARDS", 160 + e.x, 78, "#94a3b8");
          }
          if (e.attackTimer === cfg.telegraph) {
            e.state = 'telegraph';
            // A pack telegraphs with a bare glyph over its own head: three swarmers winding up
            // every second would otherwise bury the screen in "ENEMY WIND-UP!".
            if ((cfg.group || 1) > 1) {
              showFloatingCombatText("⚠️", 160 + e.x, 88, "#fbbf24");
            } else {
              showFloatingCombatText(cfg.slow ? "⚠️ HEAVY WIND-UP!" : "⚠️ ENEMY WIND-UP!", 160, 75, "#fbbf24");
            }
          } else if (e.attackTimer <= 0) {
            e.attackTimer = cfg.cadence + Math.floor(Math.random() * 50);
            e.state = 'attack';
            e.stateTimer = cfg.slow ? 20 : 14;
            e.blockTimer = 0;
            // Boss rhythm: three swings thrown from the drifting left/right patrol, then it
            // stops wandering and walks the player down for one hunted swing - after which
            // the count resets and the patrol resumes. Riding out the patrol phase at the
            // wall is survivable; riding out the hunt there is not.
            if (cfg.slow) {
              if (e.hunting) {
                e.hunting = false;      // that was the hunt's payoff - back to patrolling
                e.atkCount = 0;
              } else if (++e.atkCount >= 3) {
                e.hunting = true;
                showFloatingCombatText("⚠️ IT HUNTS YOU!", 160, 66, "#f87171");
              }
              // Coin-flip which way the boss lumbers off after the swing, so the next
              // wind-up doesn't always come from the same side. While hunting this is
              // immediately overwritten next frame by the steer-toward-player above.
              e.vx = (Math.random() < 0.5 ? -spd : spd);
            }
            landEnemyStrike(e, cfg.dmg, "DODGED! (MISS)", "🛡️ PARRY BLOCKED!", cfg.slow ? "CRUSH!" : "HP HIT!");
          }
        }
      }
    }

    // One fixed 1/60s step of combat. Pure simulation - no drawing, no DOM.
    function combatTick() {
      // The level-up box stops the world, not just the input: no stamina regen, no floating
      // text ageing, no enemy clock. It only ever opens between fights, but a frozen sim means
      // the dungeon is exactly as it was left when the choice is taken.
      if (levelUpOpen) return;

      if (combatState.inBattle && combatState.introFrame < INTRO_TOTAL) {
        combatState.introFrame++;
      }

      // Corpse dissolve, per foe. A pack member starts dithering out the moment it drops while
      // the rest of its pack fights on, so this can no longer be "the enemy is fading" - the
      // dungeon only comes back once every one of them is down AND the last corpse has
      // finished dissolving.
      if (combatState.inBattle && combatState.enemies.length && !combatState.dead) {
        let stillFading = false, allDown = true;
        for (const e of combatState.enemies) {
          if (e.deathFade > 0) {
            e.deathFade++;
            if (e.deathFade <= DEATH_FADE_FRAMES + DEATH_FADE_HOLD) stillFading = true;
          } else if (e.hp > 0) {
            allDown = false;
          }
        }
        if (allDown && !stillFading) {
          updateCombatEffects();
          finishEncounterVictory();
          return;
        }
      }

      if (battleReady() && !combatState.dead) {
        if (keysHeld.left) {
          combatState.vx = -3.8;
          combatState.glanceDir = -1;
        } else if (keysHeld.right) {
          combatState.vx = 3.8;
          combatState.glanceDir = 1;
        } else {
          combatState.vx *= 0.65;
        }
        combatState.playerX = Math.max(-85, Math.min(85, combatState.playerX + combatState.vx));

        if (keysHeld.block && combatState.playerStm > 2) {
          combatState.shieldProgress = Math.min(1.0, combatState.shieldProgress + 0.2);
          // Holding guard costs stamina; shuffling around while guarding costs much more.
          const guardMoving = keysHeld.left || keysHeld.right;
          combatState.playerStm = Math.max(0, combatState.playerStm - (guardMoving ? 0.85 : 0.3));
          combatState.faceState = 'block';
        } else {
          combatState.shieldProgress = Math.max(0.0, combatState.shieldProgress - 0.2);
        }
      }

      // Only an ACTIVE block suppresses regen. Gating on keysHeld.block alone meant a block flag
      // that never got cleared left stamina pinned just above zero forever, even out of combat.
      if (!(combatState.inBattle && keysHeld.block) && combatState.playerStm < combatState.playerMaxStm) {
        combatState.playerStm = Math.min(combatState.playerMaxStm, combatState.playerStm + 0.45);
      }

      if (combatState.attackFrame > 0) {
        combatState.attackFrame++;
        if (combatState.attackFrame === 7) {
          // Who the swing lands on. Against a lone foe that is the only answer; against a pack
          // it is the NEAREST one the blade can actually reach, so a swarmer that has closed on
          // the player is cut before one still crossing the floor, and a circler is only a
          // target while the bottom of its lap has it under the 34px reach line.
          const living = combatState.enemies.filter(k => k.hp > 0);
          let e = null;
          for (const k of living) {
            const kcfg = ENEMY_VARIANTS[k.variant] || ENEMY_VARIANTS.walker;
            if (kcfg.fly && k.altitude > 34) continue;
            if (!e || Math.abs(combatState.playerX - k.x) < Math.abs(combatState.playerX - e.x)) e = k;
          }
          if (living.length && !e) {
            // Everything left is in the air. The weapon whooshing through air, not a sound the
            // enemy makes - no cfg.sfxRate pitch, unlike hit_enemy/block/death_enemy below.
            playSfx('miss_enemy');
            showFloatingCombatText("OUT OF REACH!", 160, 90, "#93c5fd");
          } else if (e) {
            const cfg = ENEMY_VARIANTS[e.variant] || ENEMY_VARIANTS.walker;
            const guarded = e.blockTimer > 0;
            // STRENGTH picks ride on the base roll, so +4 is +4 through a guard and armour too
            // (both of which scale the total) rather than a flat bonus that dwarfs them.
            let dmg = 24 + progression.bonusAtk + Math.floor(Math.random() * 12);
            if (guarded) { dmg = Math.max(1, Math.floor(dmg * 0.25)); e.blockTimer = 0; }
            if (cfg.slow) dmg = Math.floor(dmg * 0.7);   // boss is armoured
            e.hp = Math.max(0, e.hp - dmg);
            e.state = 'hurt';
            e.stateTimer = 12;
            // Anchored on the foe that was actually hit rather than on the centre line, so in a
            // pack the number appears over the one that took it.
            showFloatingCombatText(guarded ? `BLOCKED! -${dmg}` : `-${dmg} SLASH!`,
              160 + e.x * 0.6 + (Math.random() * 20 - 10), 100, guarded ? "#94a3b8" : "#f87171");
            // The enemy's own guard soaking the blow reads as a block, not as a wound.
            // Pitched by cfg.sfxRate - see ENEMY_VARIANTS - so the same clip reads as the
            // flyer's yelp or the boss's boom depending on who is actually getting hit.
            playSfx(guarded ? 'block' : 'hit_enemy', { rate: cfg.sfxRate });

            if (e.hp <= 0) {
              e.state = 'defeated';
              e.blockTimer = 0;
              // Starts the dither-out. combatTick counts it up and calls
              // finishEncounterVictory() once every corpse has fully dissolved.
              e.deathFade = 1;
              // Same species, several sizes: one death cry serves every variant, pitched by
              // cfg.sfxRate to sell the flyer's smaller frame or the boss's bulk.
              playSfx('death_enemy', { rate: cfg.sfxRate });
              // Banked, not assigned: a pack pays out once, for all of them, when the last
              // corpse finishes dissolving.
              const xp = ENEMY_XP[e.variant] || ENEMY_XP.walker;
              combatState.pendingXp += xp;
              const left = combatState.enemies.filter(k => k.hp > 0).length;
              showFloatingCombatText(
                left ? `DOWN! +${xp} XP (${left} LEFT)` : `VICTORY! +${combatState.pendingXp} XP`,
                160, 70, "#fde047");
            }
          }
        }
        if (combatState.attackFrame > combatState.maxAttackFrames) {
          combatState.attackFrame = 0;
        }
      }

      if (combatState.hurtFrame > 0) {
        combatState.hurtFrame++;
        if (combatState.hurtFrame > combatState.maxHurtFrames) {
          combatState.hurtFrame = 0;
        }
      }

      if (combatState.faceTimer > 0) {
        combatState.faceTimer--;
        if (combatState.faceTimer <= 0) combatState.faceState = 'idle';
      }

      combatState.glanceTimer--;
      if (combatState.glanceTimer <= 0) {
        const r = Math.random();
        combatState.glanceDir = r < 0.25 ? -1 : r < 0.5 ? 1 : 0;
        combatState.glanceTimer = 60 + Math.floor(Math.random() * 80);
      }

      // battleReady(), not inBattle: a foe still dithering into existence does not get to
      // swing. Every living foe on the field takes its turn - a lone walker is a pack of one.
      if (battleReady() && !combatState.dead) {
        for (const e of combatState.enemies) {
          // The pack shares a tick, so the blow that kills the player can be followed by two
          // more from foes further down the array. Stop the moment the hero is down.
          if (combatState.dead) break;
          if (e.hp > 0) tickEnemyAI(e);
        }
      }

      updateCombatEffects();
    }

    // One displayed frame: catch the simulation up to real elapsed time, then draw once.
    //
    // Drawing lives out here rather than inside combatTick() so a slow raycast can never starve
    // the combat clock - a 40ms render just means the next frameTime is 40ms and the accumulator
    // spends it on three ticks. Also on rAF rather than setInterval so it parks properly when the
    // tab is hidden instead of raycasting an invisible canvas at whatever rate the browser allows.
    function combatFrame(now) {
      requestAnimationFrame(combatFrame);

      // Off-stage (setup / generation / menu screens). Reset the clock as well as bailing, so
      // coming back doesn't fire a burst of catch-up ticks for time the fight was never on screen.
      if (!screenGame || screenGame.classList.contains('hidden')) {
        simLastTime = now;
        simAccumulator = 0;
        return;
      }

      let frameTime = now - simLastTime;
      simLastTime = now;
      // A long stall - backgrounded tab, GC pause, texture generation - must not translate into
      // hundreds of queued ticks fast-forwarding the fight. Cap the debt at a quarter second.
      if (frameTime > 250) frameTime = 250;
      simAccumulator += frameTime;

      let steps = 0;
      while (simAccumulator >= SIM_STEP && steps < MAX_SIM_STEPS) {
        combatTick();
        simAccumulator -= SIM_STEP;
        steps++;
      }
      // Still behind after MAX_SIM_STEPS means the machine genuinely can't keep up. Drop the
      // backlog and let combat run in slow motion rather than spiral trying to catch up.
      if (steps === MAX_SIM_STEPS) simAccumulator = 0;

      if (playerHpBar) playerHpBar.style.width = `${(combatState.playerHp / combatState.playerMaxHp) * 100}%`;
      if (playerHpText) playerHpText.textContent = `${Math.ceil(combatState.playerHp)}/${combatState.playerMaxHp}`;
      if (playerStmBar) playerStmBar.style.width = `${(combatState.playerStm / combatState.playerMaxStm) * 100}%`;
      if (playerStmText) playerStmText.textContent = `${Math.ceil(combatState.playerStm)}/${combatState.playerMaxStm}`;

      renderDoomFace();
      // While a move/turn tween is running it owns the raycast (see animate3D), so skip ours.
      if (activeMode !== 'v1_video' && !player.isAnimating) {
        render3D();
      }
    }
    requestAnimationFrame(combatFrame);

    function renderDoomFace() {
      if (!doomFaceCtx) return;
      const c = doomFaceCtx;
      // Every coordinate below is authored against the original 44x44 portrait. Scaling the
      // context once here lets the canvas be backed at a much higher resolution (so the bigger
      // on-screen portrait stays crisp) without touching any of that drawing maths. setTransform
      // rather than save/restore, because this function has early returns.
      const S = doomFaceCanvas.width / 44;
      c.setTransform(S, 0, 0, S, 0, 0);
      c.clearRect(0, 0, 44, 44);

      const isHurt = combatState.faceState === 'hurt' || combatState.hurtFrame > 0;
      const isAttack = combatState.faceState === 'attack' || combatState.attackFrame > 0;
      const isBlock = combatState.shieldProgress > 0.5;

      // Pick the expression that matches what the player is doing. Hurt wins over attack, which
      // wins over block, matching the priority the body sprite uses.
      let face = playerFaceImg;
      if (playerFaceFrames.length > 1) {
        const idx = isHurt ? 3 : isAttack ? 1 : isBlock ? 2 : 0;
        face = playerFaceFrames[idx] || playerFaceFrames[0];
      }

      if (face && face.complete && face.naturalWidth > 0) {
        c.drawImage(face, 2, 2, 40, 40);

        // Combat state is shown ONLY through the border colour. Full-portrait tints used to be
        // laid over the face too, but the per-frame krea2 expressions now carry the state
        // (open-mouthed for attack, eyes shut for hurt, and so on), and the coloured wash just
        // muddied a portrait that is already doing the job. Pupils / eyebrows / mouth painted at
        // fixed coordinates were dropped earlier for the same reason - the portrait can be hooded,
        // feline, helmeted or masked, so nothing can be drawn on top at a fixed spot.
        c.strokeStyle = isHurt ? '#ef4444' : isAttack ? '#f59e0b' : isBlock ? '#38bdf8' : '#64748b';
        c.lineWidth = 2;
        c.strokeRect(1, 1, 42, 42);
        return;
      }

      // Procedural fallback
      c.fillStyle = '#0f172a';
      c.fillRect(0, 0, 44, 44);
      c.fillStyle = isHurt ? '#fca5a5' : '#fed7aa';
      c.fillRect(10, 10, 24, 26);
      c.fillStyle = '#1e3a8a';
      c.fillRect(14, 20, 4, 3);
      c.fillRect(26, 20, 4, 3);
      c.strokeStyle = isHurt ? '#ef4444' : '#64748b';
      c.lineWidth = 2;
      c.strokeRect(1, 1, 42, 42);
    }

    // ========================================================
    // VALBRACE ACCURATE MODULAR COMBAT RIG (v6)
    // ========================================================

    // 1. MODULAR WEAPON (RIGHT HAND - VALBRACE STYLE)
        // 1. MODULAR WEAPON (RIGHT HAND - VALBRACE STYLE)
    function drawModularWeapon(c, attFrame, isMoving, walkBob, shieldProgress) {
      c.save();

      if (attFrame === 0) {
        const hx = rig.swordX;
        const hy = rig.swordY + (isMoving ? walkBob * 0.5 : 0) + (shieldProgress * 4);
        const tilt = shieldProgress * 0.35;
        c.translate(hx, hy);
        c.rotate(tilt);

        c.fillStyle = '#ca8a04';
        c.beginPath(); c.arc(0, 14, 3.5, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#78350f';
        c.fillRect(-2.5, 0, 5, 14);

        c.fillStyle = '#facc15';
        c.beginPath();
        c.moveTo(-14, 0); c.bezierCurveTo(-6, -4, 6, -4, 14, 0);
        c.lineTo(14, 4); c.bezierCurveTo(6, 0, -6, 0, -14, 4);
        c.closePath(); c.fill();
        c.strokeStyle = '#a16207'; c.lineWidth = 1; c.stroke();

        c.fillStyle = '#ffffff';
        c.beginPath();
        c.moveTo(-3.5, 0); c.lineTo(-2.5, -58); c.lineTo(0, -66); c.lineTo(2.5, -58); c.lineTo(3.5, 0);
        c.closePath(); c.fill();
        c.strokeStyle = '#38bdf8'; c.lineWidth = 1.5; c.stroke();

        c.strokeStyle = '#fef08a'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(0, 0); c.lineTo(0, -60); c.stroke();

        // NO FAKE HAND - Sword is drawn behind the player's real arm!

      } else if (attFrame <= 4) {
        const hx = rig.swordX + 7;
        const hy = rig.swordY - 4;
        c.translate(hx, hy);
        c.rotate(Math.PI / 3.2);

        c.fillStyle = '#78350f'; c.fillRect(-2.5, 0, 5, 14);
        c.fillStyle = '#facc15'; c.fillRect(-12, -2, 24, 4);
        c.fillStyle = '#ffffff';
        c.beginPath();
        c.moveTo(-3.5, -2); c.lineTo(-2.5, -58); c.lineTo(0, -66); c.lineTo(2.5, -58); c.lineTo(3.5, -2);
        c.closePath(); c.fill();
        c.strokeStyle = '#38bdf8'; c.lineWidth = 1.5; c.stroke();

      } else if (attFrame <= 9) {
        const progress = (attFrame - 5) / 4;
        c.strokeStyle = 'rgba(255, 255, 255, 0.95)'; c.lineWidth = 6;
        c.beginPath(); c.moveTo(rig.swordX + 7, -20); c.quadraticCurveTo(rig.swordX + 15, -85, -35, -95); c.stroke();

        c.strokeStyle = 'rgba(56, 189, 248, 0.85)'; c.lineWidth = 3;
        c.beginPath(); c.moveTo(rig.swordX + 7, -20); c.quadraticCurveTo(rig.swordX + 15, -85, -35, -95); c.stroke();

        const bladeAngle = Math.PI / 4 - (progress * Math.PI * 0.85);
        const bx = 20 - (progress * 36);
        const by = -45 - (Math.sin(progress * Math.PI) * 22);

        c.save();
        c.translate(bx, by);
        c.rotate(bladeAngle);
        c.fillStyle = '#ffffff'; c.fillRect(-3, -58, 6, 58);
        c.strokeStyle = '#0284c7'; c.lineWidth = 1.5; c.strokeRect(-3, -58, 6, 58);
        c.restore();

        c.fillStyle = '#fde047';
        c.beginPath(); c.arc(0, -90, 15, 0, Math.PI * 2); c.fill();

      } else if (attFrame <= 13) {
        const hx = rig.swordX - 21;
        const hy = rig.swordY - 28;

        c.fillStyle = '#ffffff';
        c.beginPath();
        c.moveTo(hx - 3.5, hy + 20); c.lineTo(hx - 2, hy - 28); c.lineTo(hx, hy - 38); c.lineTo(hx + 2, hy - 28); c.lineTo(hx + 3.5, hy + 20);
        c.closePath(); c.fill();
        c.strokeStyle = '#0284c7'; c.lineWidth = 1.5; c.stroke();

        c.fillStyle = '#facc15'; c.fillRect(hx - 10, hy + 18, 20, 4);

      } else {
        const progress = (attFrame - 14) / 4;
        const hx = rig.swordX + ((1.0 - progress) * 5);
        const hy = rig.swordY - ((1.0 - progress) * 6);

        c.fillStyle = '#ffffff';
        c.save();
        c.translate(hx, hy);
        c.rotate(Math.PI / 6 * (1.0 - progress));
        c.fillRect(-2.5, -52, 5, 52);
        c.fillStyle = '#facc15'; c.fillRect(-8, -2, 16, 4);
        c.restore();
      }

      c.restore();
    }

    // 2. MODULAR SHIELD (LEFT HAND - VALBRACE STYLE)
    function drawModularShield(c, shieldProgress) {
      c.save();

      if (shieldProgress > 0.1) {
        // --- VALBRACE SHIELD RAISED UP TO HEAD / CHEST (Valbrace Image 4) ---
        // Smoothly rises from Left Flank (-28, -32) to Center High Guard (0, -68)
        const sx = -28 + (shieldProgress * 28);
        const sy = -32 - (shieldProgress * 36);
        const sw = 26 + (shieldProgress * 12);
        const sh = 34 + (shieldProgress * 14);

        c.translate(sx, sy);

        // Rectangular Curved Kite Shield
        const gradShield = c.createLinearGradient(-sw/2, -sh/2, sw/2, sh/2);
        gradShield.addColorStop(0, '#1e3a8a');
        gradShield.addColorStop(0.5, '#3b82f6');
        gradShield.addColorStop(1, '#0f172a');
        c.fillStyle = gradShield;

        c.beginPath();
        c.moveTo(-sw/2, -sh/2);
        c.lineTo(sw/2, -sh/2);
        c.lineTo(sw/2, sh/4);
        c.lineTo(0, sh/2); // Pointed Bottom
        c.lineTo(-sw/2, sh/4);
        c.closePath();
        c.fill();

        c.strokeStyle = '#facc15';
        c.lineWidth = 3;
        c.stroke();

        // Steel Boss Emblem
        c.fillStyle = '#f8fafc';
        c.beginPath(); c.arc(0, 0, 5, 0, Math.PI * 2); c.fill();
        c.strokeStyle = '#64748b'; c.lineWidth = 1; c.stroke();

        // Glowing Blue Parry Energy Barrier
        c.strokeStyle = `rgba(56, 189, 248, ${shieldProgress * 0.9})`;
        c.lineWidth = 4;
        c.beginPath();
        c.arc(0, 0, sw/2 + 6, 0, Math.PI * 2);
        c.stroke();

      } else {
        // --- NEUTRAL RESTING SHIELD AT LEFT FLANK (Valbrace Image 2 & 3) ---
        const sx = rig.shieldX;
        const sy = rig.shieldY;
        const sw = 24;
        const sh = 34;

        c.translate(sx, sy);

        const gradShield = c.createLinearGradient(-sw/2, -sh/2, sw/2, sh/2);
        gradShield.addColorStop(0, '#1e3a8a');
        gradShield.addColorStop(0.5, '#2563eb');
        gradShield.addColorStop(1, '#0f172a');
        c.fillStyle = gradShield;

        c.beginPath();
        c.moveTo(-sw/2, -sh/2);
        c.lineTo(sw/2, -sh/2);
        c.lineTo(sw/2, sh/4);
        c.lineTo(0, sh/2);
        c.lineTo(-sw/2, sh/4);
        c.closePath();
        c.fill();

        c.strokeStyle = '#facc15';
        c.lineWidth = 2.5;
        c.stroke();
      }

      c.restore();
    }

    // 1b / 2b. SPRITE GEAR (v5 / krea2) - same anchors and swing timing as the procedural
    // rig above, but blits the generated weapon & shield sprites instead of bezier shapes.
    // The weapon sprite is generated blade-up with its grip at the bottom, so it rotates
    // cleanly about a pivot near the hand.
    function blitWeaponSprite(c, pivotX, pivotY, angleRad, targetLen) {
      const img = weaponSpriteImg;
      if (!img || !img.complete || !img.naturalWidth) return;
      const h = targetLen;
      const w = h * (img.naturalWidth / img.naturalHeight);
      c.save();
      c.translate(pivotX, pivotY);
      c.rotate(angleRad);
      // Grip sits ~10% up from the bottom edge of the sprite; park that point on the pivot.
      c.drawImage(img, -w / 2, -h * 0.90, w, h);
      c.restore();
    }

    function drawSpriteWeapon(c, attFrame, isMoving, walkBob, shieldProgress) {
      if (attFrame === 0) {
        const hx = rig.swordX;
        const hy = rig.swordY + (isMoving ? walkBob * 0.5 : 0) + (shieldProgress * 4);
        blitWeaponSprite(c, hx, hy, shieldProgress * 0.35, 74);

      } else if (attFrame <= 4) {
        // Wind-up: cocked up and back over the shoulder.
        const prog = attFrame / 4;
        blitWeaponSprite(c, rig.swordX + 6, rig.swordY - 6, -0.5 - prog * 0.5, 74);

      } else if (attFrame <= 9) {
        // Slash: sweep the blade through a downward arc and trail the swipe streak.
        const progress = (attFrame - 5) / 4;
        c.strokeStyle = 'rgba(255, 255, 255, 0.95)'; c.lineWidth = 6;
        c.beginPath(); c.moveTo(rig.swordX + 7, -20); c.quadraticCurveTo(rig.swordX + 15, -85, -35, -95); c.stroke();
        c.strokeStyle = 'rgba(56, 189, 248, 0.85)'; c.lineWidth = 3;
        c.beginPath(); c.moveTo(rig.swordX + 7, -20); c.quadraticCurveTo(rig.swordX + 15, -85, -35, -95); c.stroke();

        const bx = 18 - progress * 34;
        const by = -46 - Math.sin(progress * Math.PI) * 20;
        const angle = -1.0 + progress * 2.4;      // over-the-shoulder -> swept down across body
        blitWeaponSprite(c, bx, by, angle, 78);

      } else if (attFrame <= 13) {
        // Follow-through: blade low and across to the shield side.
        blitWeaponSprite(c, rig.swordX - 20, rig.swordY - 24, 1.5, 74);

      } else {
        // Recover back to rest.
        const progress = (attFrame - 14) / 4;
        const hx = rig.swordX - (1.0 - progress) * 18;
        const hy = rig.swordY - (1.0 - progress) * 20;
        blitWeaponSprite(c, hx, hy, 1.5 * (1.0 - progress), 74);
      }
    }

    function drawSpriteShield(c, shieldProgress) {
      const img = shieldSpriteImg;
      if (!img || !img.complete || !img.naturalWidth) return;
      // Rise from the left flank to a centred high guard as the block builds.
      const sx = rig.shieldX + shieldProgress * (0 - rig.shieldX);
      const sy = rig.shieldY - shieldProgress * 34;
      const size = 40 + shieldProgress * 20;
      const w = size * (img.naturalWidth / img.naturalHeight);
      c.save();
      c.translate(sx, sy);
      c.drawImage(img, -w / 2, -size / 2, w, size);
      if (shieldProgress > 0.3) {
        c.strokeStyle = `rgba(56, 189, 248, ${shieldProgress * 0.9})`;
        c.lineWidth = 4;
        c.beginPath(); c.arc(0, 0, w / 2 + 6, 0, Math.PI * 2); c.stroke();
      }
      c.restore();
    }

    // Measured opaque bounds of a generated sprite frame, as fractions of the frame, cached per
    // <img>. The krea2 / v4 bundles don't always crop tight - a faint ground-shadow blob or an
    // uneven margin below the feet slips through - which left the multi-frame player hovering in
    // mid-scene instead of standing on the floor. Scanning the real alpha here makes placement
    // independent of how tightly the server trimmed each frame.
    const _spriteTrimCache = new WeakMap();
    let _trimScratch = null;
    function spriteTrimBox(img) {
      const cached = _spriteTrimCache.get(img);
      if (cached !== undefined) return cached;
      const iw = img.naturalWidth, ih = img.naturalHeight;
      if (!_trimScratch) _trimScratch = document.createElement('canvas');
      const cv = _trimScratch;
      // A downscaled pass is plenty to find the bounds and keeps the getImageData scan cheap.
      const scale = Math.min(1, 220 / Math.max(iw, ih));
      const sw = Math.max(1, Math.round(iw * scale));
      const sh = Math.max(1, Math.round(ih * scale));
      cv.width = sw; cv.height = sh;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.clearRect(0, 0, sw, sh);
      cx.drawImage(img, 0, 0, sw, sh);
      let data;
      try { data = cx.getImageData(0, 0, sw, sh).data; }
      catch (e) { _spriteTrimCache.set(img, null); return null; }
      let minX = sw, minY = sh, maxX = -1, maxY = -1;
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          if (data[(y * sw + x) * 4 + 3] > 14) {   // skip the near-transparent shadow fringe
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      const box = maxX < 0 ? null : {
        x: minX / sw, y: minY / sh,
        w: (maxX - minX + 1) / sw, h: (maxY - minY + 1) / sh,
      };
      _spriteTrimCache.set(img, box);
      return box;
    }

    // Draw a generated character frame so its opaque content is `contentH` px tall and its feet
    // sit at `footY` (origin-relative), horizontally centred on the origin - regardless of the
    // empty margin baked into the frame.
    function drawTrimmedSprite(c, img, footY, contentH) {
      const aspect = img.naturalWidth / img.naturalHeight;
      const box = spriteTrimBox(img);
      if (!box) {
        c.drawImage(img, -(contentH * aspect) / 2, footY - contentH, contentH * aspect, contentH);
        return;
      }
      const fullH = contentH / box.h;
      const fullW = fullH * aspect;
      const contentCX = (box.x + box.w / 2) * fullW;   // opaque centre, from the frame's left
      const contentBottom = (box.y + box.h) * fullH;   // opaque bottom, from the frame's top
      c.drawImage(img, -contentCX, footY - contentBottom, fullW, fullH);
    }

    // Like spriteTrimBox, but with a HARD alpha cut. The enemy sprite is generated small on a
    // white background and background-removed; a faint BiRefNet halo can survive that and, at
    // spriteTrimBox's alpha>14, pass as content - which made the creature read tiny with a big
    // empty margin. alpha>80 pins the box to the solid body so it can be scaled up to fill.
    const _solidBoxCache = new WeakMap();
    function solidContentBox(img) {
      const cached = _solidBoxCache.get(img);
      if (cached !== undefined) return cached;
      const iw = img.naturalWidth, ih = img.naturalHeight;
      if (!iw || !ih) return null;
      if (!_trimScratch) _trimScratch = document.createElement('canvas');
      const cv = _trimScratch;
      const scale = Math.min(1, 220 / Math.max(iw, ih));
      const sw = Math.max(1, Math.round(iw * scale));
      const sh = Math.max(1, Math.round(ih * scale));
      cv.width = sw; cv.height = sh;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.clearRect(0, 0, sw, sh);
      cx.drawImage(img, 0, 0, sw, sh);
      let data;
      try { data = cx.getImageData(0, 0, sw, sh).data; }
      catch (e) { _solidBoxCache.set(img, null); return null; }
      let minX = sw, minY = sh, maxX = -1, maxY = -1;
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          if (data[(y * sw + x) * 4 + 3] > 80) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      const box = maxX < 0 ? null : {
        x: minX / sw, y: minY / sh, w: (maxX - minX + 1) / sw, h: (maxY - minY + 1) / sh,
      };
      _solidBoxCache.set(img, box);
      return box;
    }

    // Draw an enemy frame so its SOLID content is `targetH` px tall (but never wider than
    // `maxW`), centred on cx, with the content's bottom edge at bottomY - independent of the
    // empty margin baked into the PNG.
    //
    // Both bounds are needed because the generated sprites now fill their canvas, so their
    // aspect ratios vary enormously with the subject: a RAM stick comes back 141x512 and a
    // dragon with its wingspan 503x187. Sizing on height alone would draw that dragon ~285px
    // wide on a 320px screen.
    // `sizeRef`, when given, is the frame whose measured content decides the scale - pass the
    // idle frame for every frame of a foe so it holds one size while its pose changes. The
    // server crops a foe's frames to a shared box first, so they stay registered and a lunge
    // simply extends past the idle outline instead of rescaling the whole sprite.
    function drawEnemyContent(c, img, cx, bottomY, targetH, maxW, sizeRef) {
      const aspect = img.naturalWidth / img.naturalHeight;
      // Only borrow the reference box when the two frames really are the same canvas - the
      // box is in normalised coordinates, so it means nothing against a different-sized frame
      // (which happens if the server had to crop a regenerated idle on its own).
      const ref = (sizeRef && sizeRef.complete && sizeRef.naturalWidth === img.naturalWidth
                   && sizeRef.naturalHeight === img.naturalHeight) ? sizeRef : img;
      const box = solidContentBox(ref);
      if (!box) {
        let h = targetH, w = targetH * aspect;
        if (maxW && w > maxW) { h *= maxW / w; w = maxW; }
        c.drawImage(img, cx - w / 2, bottomY - h, w, h);
        return;
      }
      // Scale the whole frame so the measured content lands on the target box.
      let fullH = targetH / box.h;
      let fullW = fullH * aspect;
      if (maxW) {
        const contentW = box.w * fullW;
        if (contentW > maxW) { const k = maxW / contentW; fullH *= k; fullW *= k; }
      }
      const contentCX = (box.x + box.w / 2) * fullW;
      const contentBottom = (box.y + box.h) * fullH;
      c.drawImage(img, cx - contentCX, bottomY - contentBottom, fullW, fullH);
    }

        // 3. COMPOSITE OVER-THE-SHOULDER PLAYER RENDERER (VALBRACE PROPORTIONS)
    function drawOverTheShoulderPlayer(c, width, height) {
      if (!combatState.inBattle) return;

      const px = width / 2 + combatState.playerX;
      const isMoving = Math.abs(combatState.vx) > 0.5;
      // Bob only while actually strafing. The old idle bob ran constantly and, on a sprite with no
      // feet planted animation, read as the character hovering rather than breathing.
      const walkBob = isMoving ? Math.sin(Date.now() / 90) * 3 : 0;
      // Battle entrance: the hero rises into frame from below the canvas. Eased out, so they
      // arrive decelerating into their stance instead of snapping to a stop.
      const slideT = Math.min(1, combatState.introFrame / INTRO_SLIDE_FRAMES);
      const slideIn = Math.pow(1 - slideT, 3) * INTRO_SLIDE_DIST;   // ease-out on the remaining gap
      const py = height + walkBob + slideIn;

      const attFrame = combatState.attackFrame;
      const hurtFrame = combatState.hurtFrame;
      const shieldProgress = combatState.shieldProgress;

      // v5 (krea2) supplies its own weapon & shield sprites; every other single-sprite mode
      // falls back to the procedural bezier rig. gearWeapon/gearShield are drop-in for the
      // drawModular* pair below.
      const useSpriteGear = activeMode === 'v5_krea' && weaponSpriteImg && weaponSpriteImg.complete && weaponSpriteImg.naturalWidth > 0;
      const gearWeapon = useSpriteGear ? drawSpriteWeapon : drawModularWeapon;
      const gearShield = (useSpriteGear && shieldSpriteImg && shieldSpriteImg.complete && shieldSpriteImg.naturalWidth > 0)
        ? drawSpriteShield : drawModularShield;

      if (hurtFrame > 0) {
        c.fillStyle = 'rgba(239, 68, 68, 0.35)';
        c.fillRect(0, 0, width, height);
      }

      c.save();
      const tilt = combatState.vx * 0.012;
      c.translate(px, py);
      c.rotate(tilt);

      // Death pose: keel the whole rig over 90 degrees so the character reads as face-down on
      // the ground. Applied at the shared save/translate so every render path below (sprite
      // sheet, single sprite, procedural rig) tips over together. The translate nudges the
      // now-horizontal body back onto the floor line instead of leaving it pivoted in the air.
      if (combatState.dead) {
        c.rotate(Math.PI / 2);
        c.translate(-18, 46);
      }

      // --- MULTI-FRAME AI SPRITE SHEET MODE (v4: 5 frames / v6: 7-frame swing) ---
      if (playerSpriteFrames && playerSpriteFrames.length > 1) {
        const v6Frames = playerSpriteFrames.length >= 7;
        // The two walk-cycle frames (7, 8) only exist on bundles generated after they were
        // added; an older 7-frame v6 bundle keeps its standing idle while strafing.
        const haveWalk = playerSpriteFrames.length >= 9;
        let currentFrame = playerSpriteFrames[0];
        if (hurtFrame > 0) {
          // v6: idle, block, windup, slash1, slash2, slash3, hurt -> hurt is frame 6.
          currentFrame = playerSpriteFrames[v6Frames ? 6 : 4] || playerSpriteFrames[0];
        } else if (attFrame > 0) {
          const prog = (combatState.attackFrame - 1) / combatState.maxAttackFrames;
          if (v6Frames) {
            // windup + three swing frames spread across the attack
            const swing = [2, 3, 4, 5];
            const k = Math.min(3, Math.max(0, Math.floor(prog * 4)));
            currentFrame = playerSpriteFrames[swing[k]] || playerSpriteFrames[0];
          } else if (prog < 0.45) {
            currentFrame = playerSpriteFrames[2] || playerSpriteFrames[0];
          } else {
            currentFrame = playerSpriteFrames[3] || playerSpriteFrames[0];
          }
        } else if (shieldProgress > 0.3) {
          currentFrame = playerSpriteFrames[1] || playerSpriteFrames[0];
        } else if (haveWalk && isMoving) {
          // Frames 7 and 8 are opposite phases of one stride, alternated in phase with the
          // existing walk bob so the foot-plant and the bob agree. They are NOT a left-step
          // and a right-step: krea2 would not reliably draw one versus the other (see
          // V6_WALK_FRAME_INDICES in server.py), and the direction of travel already reads
          // from the character sliding across the screen.
          currentFrame = playerSpriteFrames[Math.sin(Date.now() / 90) >= 0 ? 7 : 8]
                         || playerSpriteFrames[0];
        }

        if (currentFrame && currentFrame.complete && currentFrame.naturalWidth > 0) {
          // A side-step is ONE frame per direction, not a cycle, so it would otherwise sit
          // perfectly still while the player strafes. The existing walk bob supplies the
          // missing up-down; the pose frame supplies the stride.
          if (haveWalk && isMoving && attFrame <= 0 && hurtFrame <= 0) c.translate(0, walkBob * 0.6);
          // Size the character by its measured opaque height and plant its feet just past the
          // bottom edge, so a loose frame crop or a faint ground-shadow blob can't leave the
          // sprite floating in mid-scene. py is already the canvas bottom, so footY is +18.
          drawTrimmedSprite(c, currentFrame, 12, Math.round(height * 0.6));
        }
        c.restore();
        return;
      }

      // --- HURT RECOIL WITH FACE TURN TO CAMERA ---
      if (hurtFrame > 0 && hurtFrame <= 14) {
        c.translate((Math.random() * 6 - 3), -6);
        c.fillStyle = '#b45309';
        c.beginPath();
        c.moveTo(-22, 0); c.lineTo(-26, -42); c.lineTo(26, -42); c.lineTo(22, 0);
        c.closePath(); c.fill();
        c.fillStyle = '#fed7aa';
        c.beginPath(); c.arc(-3, -54, 14, 0, Math.PI * 2); c.fill();
        c.strokeStyle = '#7c2d12'; c.lineWidth = 1; c.stroke();
        c.strokeStyle = '#18181b'; c.lineWidth = 1.5;
        c.strokeRect(-10, -58, 7, 6);
        c.strokeRect(-1, -58, 7, 6);
        gearShield(c, 0);
        gearWeapon(c, 0, false, 0, 0);
        c.restore();
        return;
      }

      // =========================================================================
      // LAYER 1: WEAPONS (BEHIND Body in 2D order, deeper in 3D scene)
      // =========================================================================
      if (shieldProgress <= 0.3) {
        gearShield(c, shieldProgress);
      }

      // Neutral sword drawn BEHIND the player so the player's arm overlaps the hilt
      if (attFrame === 0) {
        gearWeapon(c, attFrame, isMoving, walkBob, shieldProgress);
      }

      // =========================================================================
      // LAYER 2: CHARACTER BODY (Foreground layer - overlaps shield & neutral sword)
      // =========================================================================
      if (playerSpriteImg && playerSpriteImg.complete && playerSpriteImg.naturalWidth > 0) {
        const spriteH = 135;
        const spriteW = spriteH * (playerSpriteImg.naturalWidth / playerSpriteImg.naturalHeight);
        rig.shieldX = (-spriteW / 2) + 5;
        rig.swordX = (spriteW / 2) - 5;
        c.drawImage(playerSpriteImg, -spriteW / 2, -spriteH + 12, spriteW, spriteH);
      } else {
        rig.shieldX = -28;
        rig.swordX = 24;
        const gradTorso = c.createLinearGradient(-22, -45, 22, 0);
        gradTorso.addColorStop(0, '#b45309');
        gradTorso.addColorStop(0.5, '#d97706');
        gradTorso.addColorStop(1, '#78350f');
        c.fillStyle = gradTorso;
        c.beginPath();
        c.moveTo(-22, 0); c.lineTo(-26, -46); c.lineTo(26, -46); c.lineTo(22, 0);
        c.closePath(); c.fill();
        c.strokeStyle = '#451a03'; c.lineWidth = 1.5; c.stroke();
        c.fillStyle = '#fed7aa';
        c.beginPath(); c.arc(0, -58, 14, 0, Math.PI * 2); c.fill();
        c.strokeStyle = '#7c2d12'; c.lineWidth = 1; c.stroke();
      }

      // =========================================================================
      // LAYER 3: RAISED SHIELD & ACTIVE SWORD SWING (Overlaying character body)
      // =========================================================================
      if (shieldProgress > 0.3) {
        gearShield(c, shieldProgress);
      }

      // When actively swinging the sword, it sweeps across the foreground
      if (attFrame > 0) {
        gearWeapon(c, attFrame, isMoving, walkBob, shieldProgress);
      }
      
      c.restore();
    }

    // ==========================================
    // DITHERED FADES (ordered 4x4 Bayer)
    // ==========================================
    // A straight globalAlpha fade turns a sprite into a ghost - it goes translucent and you see
    // the corridor through it. What the enemies want instead is the 8-bit dissolve: every pixel
    // stays fully opaque, and the SET of pixels drawn grows (materialising) or shrinks (dying)
    // through an ordered dither. That can't be done with alpha, so it is done by punching holes:
    // draw the sprite into an offscreen canvas at 1:1 with the 320x240 view, erase a Bayer
    // pattern of pixels out of it with destination-out, then blit the result over the scene.
    //
    // 17 patterns are pre-built (0..16 of the 4x4 matrix's cells kept) and cached, so a fade
    // costs one fillRect per frame rather than any per-pixel work.
    const BAYER4 = [
      [0, 8, 2, 10],
      [12, 4, 14, 6],
      [3, 11, 1, 9],
      [15, 7, 13, 5],
    ];
    let _fxCanvas = null, _fxC = null;
    const _ditherPatterns = new Array(17).fill(null);

    // Clear and hand back the offscreen scratch view, sized exactly like the viewport so
    // anything drawn into it lands on the same pixel when blitted back.
    function fxLayer() {
      if (!_fxCanvas) {
        _fxCanvas = document.createElement('canvas');
        _fxCanvas.width = screenWidth;
        _fxCanvas.height = screenHeight;
        _fxC = _fxCanvas.getContext('2d');
      }
      _fxC.setTransform(1, 0, 0, 1, 0, 0);
      _fxC.globalAlpha = 1;
      _fxC.globalCompositeOperation = 'source-over';
      _fxC.clearRect(0, 0, screenWidth, screenHeight);
      return _fxC;
    }

    // Pattern of the pixels to ERASE for a fade that keeps `keep` (0..1) of them.
    function ditherErasePattern(keep) {
      const level = Math.max(0, Math.min(16, Math.round(keep * 16)));
      if (!_ditherPatterns[level]) {
        const tile = document.createElement('canvas');
        tile.width = 4; tile.height = 4;
        const tc = tile.getContext('2d');
        tc.fillStyle = '#000';
        for (let y = 0; y < 4; y++) {
          for (let x = 0; x < 4; x++) {
            // Cells whose threshold is at or above the kept count get erased.
            if (BAYER4[y][x] >= level) tc.fillRect(x, y, 1, 1);
          }
        }
        _ditherPatterns[level] = _fxC.createPattern(tile, 'repeat');
      }
      return _ditherPatterns[level];
    }

    // Finish an fxLayer(): darken it to `shade`, dissolve it to `keep`, blit it to `c`.
    // Both effects are clipped to what was actually drawn (source-atop / destination-out), so
    // the empty rest of the scratch canvas stays empty and the scene shows through it.
    function blitFxLayer(c, keep = 1, shade = 1) {
      if (keep <= 0) return;
      // Both fills below cover the whole layer, and a pattern fill is laid down in the CURRENT
      // transform - so reset it, whatever the caller was drawing with.
      _fxC.setTransform(1, 0, 0, 1, 0, 0);
      _fxC.globalAlpha = 1;
      if (shade < 1) {
        _fxC.globalCompositeOperation = 'source-atop';
        _fxC.fillStyle = `rgba(0,0,0,${(1 - shade).toFixed(3)})`;
        _fxC.fillRect(0, 0, screenWidth, screenHeight);
      }
      if (keep < 1) {
        _fxC.globalCompositeOperation = 'destination-out';
        _fxC.fillStyle = ditherErasePattern(keep);
        _fxC.fillRect(0, 0, screenWidth, screenHeight);
      }
      _fxC.globalCompositeOperation = 'source-over';
      c.drawImage(_fxCanvas, 0, 0);
    }

    // ==========================================
    // WORLD ENEMY MARKERS (exploration view)
    // ==========================================
    // The floating foe you walk into to start a fight. Camera-facing billboards, drawn after
    // the raycast has been flushed to the canvas so they can be real drawImage() calls (the
    // sprites are Images, not ImageData) - which means occlusion has to be re-done by hand:
    // each marker is clipped to the runs of screen columns where it is nearer than the wall
    // the raycaster already recorded in zBuffer.
    const MARKER_HEIGHT_FRAC = 0.46;   // of the wall height at the marker's distance
    const MARKER_WIDTH_FRAC = 0.62;
    const MARKER_HOVER_FRAC = 0.24;    // lifted off the floor line by this much of a wall
    // A marker is drawn at its own variant's proportions relative to the walker, so the corridor
    // tells the player what is waiting before they step into it: a dread boss looms half again
    // as large, and a flyer hangs higher up the passage.
    function markerScaleFor(variant) {
      const cfg = ENEMY_VARIANTS[variant] || ENEMY_VARIANTS.walker;
      return {
        size: cfg.heightFrac / ENEMY_VARIANTS.walker.heightFrac,
        // cfg.hover is in combat-canvas pixels (0..240); as a fraction of a wall it reads the
        // same at any distance.
        lift: (cfg.hover || 0) / screenHeight,
      };
    }
    function drawWorldEnemies(c, posX, posY, dirX, dirY, planeX, planeY) {
      if (!enemyMarkers.length) return;
      const invDet = 1.0 / (planeX * dirY - dirX * planeY);

      const visible = [];
      for (const m of enemyMarkers) {
        if (!m.alive) continue;
        const relX = (m.x + 0.5) - posX;
        const relY = (m.y + 0.5) - posY;
        const tX = invDet * (dirY * relX - dirX * relY);
        const tY = invDet * (-planeY * relX + planeX * relY);
        if (tY < 0.28) continue;                    // behind the camera or inside it
        visible.push({ m, tX, tY });
      }
      if (!visible.length) return;
      visible.sort((a, b) => b.tY - a.tY);          // far to near, so nearer foes overlap

      for (const v of visible) {
        const wallH = (screenHeight * WALL_HEIGHT) / v.tY;
        const screenX = (screenWidth / 2) * (1 + v.tX / v.tY);
        const floorY = screenHeight / 2 + wallH / 2;
        const scale = markerScaleFor(v.m.variant);
        // A flyer bobs faster and further than something standing on the floor.
        const bobRate = scale.lift > 0 ? 260 : 430;
        const bob = Math.sin(Date.now() / bobRate + v.m.phase) * (wallH * (scale.lift > 0 ? 0.055 : 0.035));
        const bottomY = floorY - wallH * (MARKER_HOVER_FRAC + scale.lift) + bob;

        const img = markerFrameFor(v.m.variant);
        const targetH = wallH * MARKER_HEIGHT_FRAC * scale.size;
        const maxW = wallH * MARKER_WIDTH_FRAC * scale.size;
        let drawW, drawH, drawX, drawY;
        if (img) {
          const box = solidContentBox(img);
          const aspect = img.naturalWidth / img.naturalHeight;
          drawH = targetH;
          drawW = drawH * aspect;
          if (box) {
            // Same content-box sizing the battle view uses, so a sprite with a big transparent
            // margin isn't drawn as a thumbnail floating in an invisible box.
            let fullH = drawH / box.h;
            let fullW = fullH * aspect;
            if (box.w * fullW > maxW) { const k = maxW / (box.w * fullW); fullH *= k; fullW *= k; }
            drawW = fullW; drawH = fullH;
            drawX = screenX - (box.x + box.w / 2) * fullW;
            drawY = bottomY - (box.y + box.h) * fullH;
          } else {
            if (drawW > maxW) { drawH *= maxW / drawW; drawW = maxW; }
            drawX = screenX - drawW / 2;
            drawY = bottomY - drawH;
          }
        } else {
          drawH = targetH;
          drawW = drawH;
          drawX = screenX - drawW / 2;
          drawY = bottomY - drawH;
        }

        // A pack marker shows the pack: the same sprite drawn `group` times, spread along the
        // corridor and each bobbing on its own phase so it reads as several small foes rather
        // than one blurred silhouette. Offsets are fractions of the drawn width, so the spread
        // holds at any distance.
        const groupN = Math.max(1, (ENEMY_VARIANTS[v.m.variant] || {}).group || 1);
        const members = [];
        for (let i = 0; i < groupN; i++) {
          members.push({
            dx: groupN === 1 ? 0 : (i - (groupN - 1) / 2) * drawW * 0.60,
            dy: groupN === 1 ? 0 : Math.sin(Date.now() / bobRate + v.m.phase + i * 1.9) * wallH * 0.02,
          });
        }
        const spread = members.reduce((m, k) => Math.max(m, Math.abs(k.dx)), 0);
        const wobble = members.reduce((m, k) => Math.max(m, Math.abs(k.dy)), 0);

        // Cheap reject before the per-column occlusion scan.
        const spanL = Math.floor(Math.min(drawX, screenX - drawW / 2) - spread);
        const spanR = Math.ceil(Math.max(drawX + drawW, screenX + drawW / 2) + spread);
        if (spanR < 0 || spanL >= screenWidth) continue;

        // Walk the sprite's columns and collect the unoccluded runs. Clipping to those rects
        // is what lets a marker be half-hidden behind a corner instead of popping into view
        // whole the moment its centre clears the wall.
        c.save();
        c.beginPath();
        let runStart = -1, runs = 0;
        // The band has to reach the floor line as well as the sprite: the marker hovers, so its
        // ground shadow sits well below its own bottom edge and would be clipped off otherwise.
        const clipTop = Math.max(0, Math.floor(Math.min(drawY - wobble, floorY)) - 2);
        const clipBottom = Math.min(screenHeight, Math.ceil(Math.max(drawY + drawH + wobble, floorY + wallH * 0.06)) + 2);
        const clipH = Math.max(1, clipBottom - clipTop);
        for (let x = Math.max(0, spanL); x <= Math.min(screenWidth - 1, spanR); x++) {
          const open = v.tY < zBuffer[x];
          if (open && runStart < 0) runStart = x;
          else if (!open && runStart >= 0) { c.rect(runStart, clipTop, x - runStart, clipH); runs++; runStart = -1; }
        }
        if (runStart >= 0) { c.rect(runStart, clipTop, Math.min(screenWidth, spanR + 1) - runStart, clipH); runs++; }
        if (!runs) { c.restore(); continue; }
        c.clip();

        // Distance shading matched to the wall pass, so a marker down a long corridor sinks
        // into the same gloom the stonework does. Floored higher than a wall's, because these
        // read as lit from within.
        const shade = Math.max(0.45, 1.0 / (1.0 + v.tY * 0.30));

        const f = fxLayer();
        // Ground shadows first, so they are shaded and clipped with the bodies.
        f.fillStyle = 'rgba(0,0,0,0.34)';
        for (const k of members) {
          f.beginPath();
          f.ellipse(screenX + k.dx, floorY - wallH * 0.02, drawW * 0.22, wallH * 0.035, 0, 0, Math.PI * 2);
          f.fill();
        }

        if (img) {
          for (const k of members) f.drawImage(img, drawX + k.dx, drawY + k.dy, drawW, drawH);
        } else {
          // No generated sprite (v1 video mode, or a bundle whose enemy failed): a plain
          // hovering sigil still tells the player a fight is parked on this tile.
          const r = drawW / 2;
          const cx = screenX, cy = bottomY - r;
          const g = f.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
          g.addColorStop(0, '#f87171');
          g.addColorStop(0.6, '#7f1d1d');
          g.addColorStop(1, 'rgba(24,0,0,0)');
          f.fillStyle = g;
          f.beginPath(); f.arc(cx, cy, r, 0, Math.PI * 2); f.fill();
          f.fillStyle = '#fde047';
          f.fillRect(cx - r * 0.45, cy - r * 0.15, r * 0.3, r * 0.14);
          f.fillRect(cx + r * 0.15, cy - r * 0.15, r * 0.3, r * 0.14);
        }
        blitFxLayer(c, 1, shade);
        c.restore();
      }
    }

    // High-Detail Shaded Dark Fantasy Demon Knight Enemy
    // The foe, its entrance and its dissolve. The body is drawn through an offscreen layer
    // whenever it is part-way through a fade, so the dither can punch holes in the finished
    // figure rather than in each shape it is built from - see blitFxLayer. The name plate is
    // never dithered: it belongs to the HUD, and it stays up through the dissolve so the kill
    // reads as a kill.
    function drawCombatEnemy(c, width, height) {
      if (!combatState.inBattle) return;

      // Back to front, by altitude: whatever is highest is furthest up the arena, so it is
      // laid down first and anything on the floor overlaps it. Sorted on a copy - the array
      // order is the pack order everywhere else (formOffset, orbit phase) and must not move.
      const order = combatState.enemies
        .filter(e => e.hp > 0 || e.deathFade > 0)
        .slice()
        .sort((a, b) => (b.altitude || 0) - (a.altitude || 0));

      for (const e of order) {
        // Each foe carries its own dissolve, so in a pack one corpse dithers away while the
        // rest are still solid - which means the fade layer is per foe, not per frame.
        const fade = enemyVisibility(e);
        if (fade <= 0) continue;
        if (fade < 1) {
          drawEnemyBody(fxLayer(), width, height, e);
          blitFxLayer(c, fade, 1);
        } else {
          drawEnemyBody(c, width, height, e);
        }
      }
      // The plate waits for the foe to start materialising rather than announcing a creature
      // that isn't on screen yet - but it stays up through the dissolve, so the emptied health
      // bar is the last thing seen of it. That is exactly the window enemyVisibility opens at,
      // and it has to be read off the clock rather than off the lead: in a pack the lead can
      // be the first one down, and the plate belongs to the whole pack.
      if (combatState.introFrame > INTRO_FADE_DELAY) drawEnemyHpBar(c, width, combatState.enemy);
    }

    function drawEnemyBody(c, width, height, which) {
      const e = which || combatState.enemy;
      const cfg = ENEMY_VARIANTS[e.variant] || ENEMY_VARIANTS.walker;
      const GROUND_Y = 165;                       // where a grounded enemy's feet sit
      const ex = width / 2 + (e.x || 0);
      // The winner's dance: once the player is down, the enemy bounces straight up and down on
      // the spot, celebrating. Negative = higher on the canvas; abs(sin) so it only ever leaves
      // the ground and lands, never sinks through it.
      const victoryHop = combatState.dead ? -Math.abs(Math.sin(Date.now() / 130)) * 24 : 0;
      const ey = (GROUND_Y - 70) - (e.altitude || 0) + Math.sin(Date.now() / 200) * 4 + victoryHop;

      // No telegraph circle - the attack frame shows the wind-up, and the "ENEMY WIND-UP!"
      // floating text still calls it.

      // --- AI ENEMY SPRITE (idle / attack / hurt) ---
      // Falls through to the procedural enemy below when no sprites were generated, so an enemy
      // that failed to generate (or a dungeon made before this existed) still has an opponent.
      if (enemySpriteFrames && enemySpriteFrames.length > 0) {
        // Per-variant frame set (idle / attack / block) when the bundle has one; otherwise the
        // legacy flat [idle, attack, hurt] array from v3/v4.
        // Looked up per draw rather than read off the global: a pack foe's set is a recolour
        // built on demand, and the first frames of a fight can land before the sprite it
        // borrows has finished decoding - in which case enemyFramesFor hands back the untinted
        // original and quietly upgrades itself once the source is ready.
        const frames = enemyFramesFor(e.variant) || enemyFrames;
        let frame, sizeRef = null;
        if (frames && frames.idle) {
          frame = frames.idle;
          // Attack wins over block: the AI clears blockTimer when it commits to a strike, so
          // these do not overlap in practice, but the strike is the one that must read.
          if (e.state === 'attack' || e.state === 'telegraph') frame = frames.attack || frame;
          else if (e.blockTimer > 0) frame = frames.block || frame;
          // Scale EVERY frame by the idle's content box. Sizing each frame on its own box
          // would shrink the whole foe whenever it lunged, since a thrust-out limb measures
          // bigger; anchoring on the idle keeps it a constant size and lets the attack frame
          // genuinely reach further than the idle silhouette.
          sizeRef = frames.idle;
        } else {
          frame = enemySpriteFrames[0];
          if (e.state === 'hurt') frame = enemySpriteFrames[2] || frame;
          else if (e.state === 'attack' || e.state === 'telegraph') frame = enemySpriteFrames[1] || frame;
        }

        if (frame && frame.complete && frame.naturalWidth > 0) {
          // Size by MEASURED solid content, not the raw frame - a small generation still fills
          // the combat view. heightFrac is per-variant: boss looms, flyer is smaller & airborne.
          const targetH = Math.round(height * cfg.heightFrac);
          const maxW = Math.round(width * (cfg.widthFrac || 0.7));
          const bob = cfg.fly ? Math.sin(Date.now() / 110) * 4 : Math.sin(Date.now() / 220) * 3;
          const bottomY = GROUND_Y - (e.altitude || 0) + bob + victoryHop;

          c.save();
          // Ground shadow - fades and shrinks as a flyer climbs.
          const sh = cfg.fly ? Math.max(0.14, 1 - (e.altitude || 0) / 90) : 1;
          c.fillStyle = `rgba(0,0,0,${0.28 * sh})`;
          c.beginPath();
          c.ellipse(width / 2 + (e.x || 0), GROUND_Y + 3, targetH * 0.32 * sh, targetH * 0.08 * sh, 0, 0, Math.PI * 2);
          c.fill();

          if (e.state === 'hurt') { c.translate((Math.random() * 8 - 4), 0); c.globalAlpha = 0.9; }
          else if (e.blockTimer > 0) { c.globalAlpha = 0.94; }

          drawEnemyContent(c, frame, ex, bottomY, targetH, maxW, sizeRef);
          c.globalAlpha = 1;

          // In a pack the plate at the top of the screen is the pack's total, so each member
          // carries its own thin bar to show which one is actually being worn down. A lone foe
          // has the plate and doesn't need one.
          if (combatState.enemies.length > 1 && e.hp > 0) {
            // Floored below the name plate (which owns y 8..26): a circler at the top of its
            // arc sits high enough that its bar would otherwise land on top of it.
            drawEnemyPipBar(c, ex, Math.max(32, bottomY - targetH - 10), e);
          }

          // The guard arc and the boss aura that used to be stroked over the sprite here are
          // gone, along with the telegraph circle above. They were standing in for poses the
          // sprites could not show; each foe now has its own generated block and attack frame,
          // so the pose carries it and the shapes on top just obscured the art.
          c.restore();
          return;
        }
      }

      const isHurt = e.state === 'hurt';
      c.save();
      if (isHurt) c.translate((Math.random() * 8 - 4), 0);

      // Spiked Pauldrons
      c.fillStyle = isHurt ? '#7f1d1d' : '#18181b';
      c.beginPath();
      c.moveTo(ex - 15, ey - 10); c.lineTo(ex - 48, ey - 32); c.lineTo(ex - 52, ey - 10); c.lineTo(ex - 20, ey + 15);
      c.closePath(); c.fill();
      c.strokeStyle = '#38bdf8'; c.lineWidth = 1.5; c.stroke();

      c.beginPath();
      c.moveTo(ex + 15, ey - 10); c.lineTo(ex + 48, ey - 32); c.lineTo(ex + 52, ey - 10); c.lineTo(ex + 20, ey + 15);
      c.closePath(); c.fill();
      c.strokeStyle = '#38bdf8'; c.lineWidth = 1.5; c.stroke();

      // Chestplate
      const gradTorso = c.createRadialGradient(ex, ey + 10, 4, ex, ey + 10, 32);
      gradTorso.addColorStop(0, isHurt ? '#ef4444' : '#312e81');
      gradTorso.addColorStop(0.7, isHurt ? '#991b1b' : '#0f172a');
      gradTorso.addColorStop(1, '#020617');
      c.fillStyle = gradTorso;

      c.beginPath();
      c.moveTo(-24 + ex, ey - 12); c.lineTo(24 + ex, ey - 12); c.lineTo(18 + ex, ey + 32); c.lineTo(-18 + ex, ey + 32);
      c.closePath(); c.fill();
      c.strokeStyle = '#475569'; c.lineWidth = 2; c.stroke();

      // Rune
      c.fillStyle = e.state === 'telegraph' ? '#fde047' : '#ef4444';
      c.beginPath();
      c.moveTo(ex, ey - 4); c.lineTo(ex + 8, ey + 8); c.lineTo(ex, ey + 20); c.lineTo(ex - 8, ey + 8);
      c.closePath(); c.fill();

      // Horned Helmet
      const gradHelm = c.createRadialGradient(ex, ey - 22, 2, ex, ey - 22, 20);
      gradHelm.addColorStop(0, '#475569'); gradHelm.addColorStop(0.8, '#0f172a'); gradHelm.addColorStop(1, '#020617');
      c.fillStyle = gradHelm;

      c.beginPath();
      c.moveTo(ex - 18, ey - 12); c.lineTo(ex - 16, ey - 36); c.lineTo(ex, ey - 44); c.lineTo(ex + 16, ey - 36); c.lineTo(ex + 18, ey - 12);
      c.closePath(); c.fill();
      c.strokeStyle = '#1e293b'; c.lineWidth = 2; c.stroke();

      // Horns
      c.fillStyle = '#020617';
      c.beginPath();
      c.moveTo(ex - 14, ey - 32); c.bezierCurveTo(ex - 36, ey - 42, ex - 44, ey - 60, ex - 32, ey - 65); c.bezierCurveTo(ex - 32, ey - 50, ex - 22, ey - 40, ex - 10, ey - 36);
      c.moveTo(ex + 14, ey - 32); c.bezierCurveTo(ex + 36, ey - 42, ex + 44, ey - 60, ex + 32, ey - 65); c.bezierCurveTo(ex + 32, ey - 50, ex + 22, ey - 40, ex + 10, ey - 36);
      c.fill();
      c.strokeStyle = '#dc2626'; c.lineWidth = 1.5; c.stroke();

      // Glowing Eyes
      c.fillStyle = e.state === 'telegraph' ? '#facc15' : '#ef4444';
      c.fillRect(ex - 12, ey - 24, 10, 4);
      c.fillRect(ex + 2, ey - 24, 10, 4);

      c.restore();
    }

    // Pulled out of drawCombatEnemy so the AI-sprite path can draw it too - that path returns
    // early to skip the procedural body, which silently took the name plate with it.
    function drawEnemyHpBar(c, width, e) {
      // A pack shares one plate: the bar is the whole pack's remaining HP and the count is how
      // many of them are still standing, so it empties over the fight the way a single foe's
      // does. Which one you are currently cutting into is read off the little bar over its own
      // head - see drawEnemyPipBar. The plate is widened to fit the extra "x3".
      const pack = combatState.enemies;
      const isPack = pack.length > 1;
      const hp = isPack ? pack.reduce((s, k) => s + Math.max(0, k.hp), 0) : e.hp;
      const maxHp = isPack ? pack.reduce((s, k) => s + k.maxHp, 0) : e.maxHp;
      const label = isPack
        ? `${e.name || 'NIGHTSTALKER'} x${pack.filter(k => k.hp > 0).length} [${hp}/${maxHp}]`
        : `${e.name || 'NIGHTSTALKER'} [${e.hp}/${e.maxHp}]`;
      const w = isPack ? 196 : 150;

      c.fillStyle = 'rgba(15, 23, 42, 0.9)';
      c.fillRect(width / 2 - w / 2, 8, w, 18);
      c.strokeStyle = '#94a3b8'; c.lineWidth = 1.5;
      c.strokeRect(width / 2 - w / 2, 8, w, 18);

      const hpW = Math.max(0, (hp / maxHp) * (w - 4));
      c.fillStyle = '#dc2626';
      c.fillRect(width / 2 - w / 2 + 2, 10, hpW, 14);

      c.fillStyle = '#f8fafc';
      c.font = 'bold 10px sans-serif';
      c.textAlign = 'center';
      c.fillText(label, width / 2, 21);
    }

    // The thin HP bar a pack member wears over its own head. Deliberately tiny and unlabelled -
    // it is there to say "this is the one you have been hitting", not to be read as a number.
    function drawEnemyPipBar(c, cx, y, e) {
      const w = 30, h = 4;
      c.fillStyle = 'rgba(15, 23, 42, 0.85)';
      c.fillRect(cx - w / 2 - 1, y - 1, w + 2, h + 2);
      c.fillStyle = '#dc2626';
      c.fillRect(cx - w / 2, y, Math.max(0, (e.hp / e.maxHp) * w), h);
      c.strokeStyle = 'rgba(148, 163, 184, 0.75)'; c.lineWidth = 1;
      c.strokeRect(cx - w / 2 - 1.5, y - 1.5, w + 3, h + 3);
    }

    // Floating text ages on the SIMULATION clock, not the render clock - it used to age inside
    // drawCombatEffects, which meant a slow frame stretched the popups along with everything
    // else. Advancing it in combatTick keeps `life: 32` worth ~0.53s no matter the frame rate.
    function updateCombatEffects() {
      for (let i = combatState.combatEffects.length - 1; i >= 0; i--) {
        const eff = combatState.combatEffects[i];
        eff.life--;
        eff.y -= 0.8;
        if (eff.life <= 0) {
          combatState.combatEffects.splice(i, 1);
        }
      }
    }

    // Pure draw - mutating sim state from here would double up whenever a frame runs more than
    // one simulation step. See updateCombatEffects above.
    function drawCombatEffects(c) {
      for (let i = 0; i < combatState.combatEffects.length; i++) {
        const eff = combatState.combatEffects[i];
        c.fillStyle = eff.color;
        c.font = 'bold 12px monospace';
        c.textAlign = 'center';
        c.shadowColor = '#000000';
        c.shadowBlur = 4;
        c.fillText(eff.text, eff.x, eff.y);
        c.shadowBlur = 0;
      }
    }

    // ==========================================
    // PROCEDURAL TEXTURE GENERATION
    // ==========================================
    function buildDefaultTextures() {
      const cv = document.createElement('canvas');
      cv.width = cv.height = TEX_SIZE;
      const c = cv.getContext('2d');
      c.imageSmoothingEnabled = false;

      // Windows 95 Crimson Red Brick Wall
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, TEX_SIZE, TEX_SIZE);

      const rows = 4;
      const rowHeight = TEX_SIZE / rows;
      const mortar = 8;

      for (let r = 0; r < rows; r++) {
        const y = r * rowHeight + mortar / 2;
        const h = rowHeight - mortar;
        const off = (r % 2 === 0) ? 0 : TEX_SIZE / 4;

        for (let x = -TEX_SIZE / 2; x < TEX_SIZE * 1.5; x += TEX_SIZE / 2) {
          const bx = x + off + mortar / 2;
          const bw = TEX_SIZE / 2 - mortar;

          c.fillStyle = '#9e1414';
          c.fillRect(bx, y, bw, h);

          c.fillStyle = 'rgba(239, 68, 68, 0.45)';
          c.fillRect(bx + 2, y + 2, bw - 4, 3);
          c.fillRect(bx + 2, y + 2, 3, h - 4);

          c.fillStyle = 'rgba(69, 10, 10, 0.55)';
          c.fillRect(bx + 2, y + h - 5, bw - 4, 3);
          c.fillRect(bx + bw - 5, y + 2, 3, h - 4);
        }
      }
      wallTexture = c.getImageData(0, 0, TEX_SIZE, TEX_SIZE);

      // Drop Ceiling
      c.fillStyle = '#f8fafc';
      c.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
      c.strokeStyle = '#94a3b8';
      c.lineWidth = 4;
      c.strokeRect(0, 0, TEX_SIZE, TEX_SIZE);
      c.beginPath();
      c.moveTo(0, TEX_SIZE / 2); c.lineTo(TEX_SIZE, TEX_SIZE / 2);
      c.moveTo(TEX_SIZE / 2, 0); c.lineTo(TEX_SIZE / 2, TEX_SIZE);
      c.stroke();
      ceilingTexture = c.getImageData(0, 0, TEX_SIZE, TEX_SIZE);

      // Parquet Floor
      c.fillStyle = '#c27e2c';
      c.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
      const half = TEX_SIZE / 2;
      for (let py = 0; py < 2; py++) {
        for (let px = 0; px < 2; px++) {
          const ox = px * half;
          const oy = py * half;
          const isHoriz = (px + py) % 2 === 0;
          c.strokeStyle = '#78350f';
          c.lineWidth = 2;
          c.strokeRect(ox, oy, half, half);
          for (let k = 1; k <= 3; k++) {
            c.beginPath();
            if (isHoriz) {
              c.moveTo(ox, oy + (half / 4) * k);
              c.lineTo(ox + half, oy + (half / 4) * k);
            } else {
              c.moveTo(ox + (half / 4) * k, oy);
              c.lineTo(ox + (half / 4) * k, oy + half);
            }
            c.stroke();
          }
        }
      }
      floorTexture = c.getImageData(0, 0, TEX_SIZE, TEX_SIZE);

      buildLanternWallFromBase(wallTexture, "Windows 95");
      buildExitStairsTexture("Windows 95", wallTexture);
      buildDoorTexture(wallTexture, "Windows 95");
      buildOpenDoorTexture();
      buildSwitchWallTextures(wallTexture, "Windows 95");
    }

    function buildLanternWallFromBase(baseWallImageData, styleName = "Windows 95") {
      const cv = document.createElement('canvas');
      cv.width = cv.height = TEX_SIZE;
      const c = cv.getContext('2d');
      c.imageSmoothingEnabled = false;

      c.putImageData(baseWallImageData, 0, 0);

      const isWin95 = styleName.toLowerCase().includes('windows');

      const radGrad = c.createRadialGradient(128, 95, 10, 128, 95, 115);
      radGrad.addColorStop(0, 'rgba(255, 220, 90, 0.85)');
      radGrad.addColorStop(0.5, 'rgba(245, 158, 11, 0.4)');
      radGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      c.fillStyle = radGrad;
      c.fillRect(18, 0, 220, 220);

      if (aiLanternImg && aiLanternImg.complete && aiLanternImg.naturalWidth > 0) {
        // AI-generated fixture themed to this dungeon's own style (see lantern_p in
        // server.py's get_surface_prompts) - matted onto the wall the same way the
        // background-removed weapon/shield sprites are, bottom-anchored over the bracket
        // position the procedural shapes below used.
        //
        // The model is only asked WHAT the object is, never to render it lit: FLUX schnell at
        // 4 steps returns a convincing themed object but renders actual emission maybe half the
        // time (a haunted manor came back with glowing windows, a taco came back looking like
        // lunch), and BiRefNet crops off any halo it does draw. So the "lit" half is done here
        // instead, where it is deterministic and every theme gets it.
        //
        // Sizing matches the footprint the procedural crystal sconce below used to occupy
        // (roughly 36x96 of the 256x256 texture).
        const maxW = 60, maxH = 100;
        const scale = Math.min(maxW / aiLanternImg.naturalWidth, maxH / aiLanternImg.naturalHeight, 1);
        const dw = aiLanternImg.naturalWidth * scale;
        const dh = aiLanternImg.naturalHeight * scale;
        const dx = 128 - dw / 2;
        const dy = 146 - dh;
        const gx = dx + dw / 2;
        const gy = dy + dh / 2;

        // Outer bloom first, additive, so light appears to spill from the fixture onto the wall.
        const bloom = c.createRadialGradient(gx, gy, 2, gx, gy, Math.max(dw, dh) * 0.95);
        bloom.addColorStop(0, 'rgba(255, 236, 160, 0.80)');
        bloom.addColorStop(0.45, 'rgba(255, 176, 60, 0.32)');
        bloom.addColorStop(1, 'rgba(255, 140, 0, 0)');
        c.globalCompositeOperation = 'lighter';
        c.fillStyle = bloom;
        c.fillRect(dx - dw, dy - dh * 0.5, dw * 3, dh * 2.2);
        c.globalCompositeOperation = 'source-over';

        // Then the sprite, pre-lit on its own canvas. 'source-atop' confines the warm wash to
        // the sprite's own alpha, so the transparent margin never picks up a rectangular haze.
        const lg = document.createElement('canvas');
        lg.width = Math.max(1, Math.ceil(dw));
        lg.height = Math.max(1, Math.ceil(dh));
        const lc = lg.getContext('2d');
        lc.imageSmoothingEnabled = true;
        lc.drawImage(aiLanternImg, 0, 0, lg.width, lg.height);
        const inner = lc.createRadialGradient(lg.width / 2, lg.height / 2, 1,
                                              lg.width / 2, lg.height / 2,
                                              Math.max(lg.width, lg.height) * 0.7);
        inner.addColorStop(0, 'rgba(255, 245, 200, 0.72)');
        inner.addColorStop(0.6, 'rgba(255, 190, 80, 0.40)');
        inner.addColorStop(1, 'rgba(255, 150, 40, 0.16)');
        lc.globalCompositeOperation = 'source-atop';
        lc.fillStyle = inner;
        lc.fillRect(0, 0, lg.width, lg.height);

        c.imageSmoothingEnabled = true;
        c.drawImage(lg, dx, dy);
        c.imageSmoothingEnabled = false;
      } else if (isWin95) {
        // Windows 95 Logo Lantern
        c.fillStyle = '#18181b'; c.fillRect(122, 112, 12, 30);
        c.strokeStyle = '#000000'; c.lineWidth = 4;
        c.beginPath(); c.moveTo(128, 115); c.lineTo(128, 70); c.stroke();

        c.fillStyle = '#27272a';
        c.beginPath(); c.moveTo(108, 70); c.lineTo(148, 70); c.lineTo(128, 54); c.closePath(); c.fill();

        c.fillStyle = '#ef4444'; c.fillRect(112, 72, 14, 14);
        c.fillStyle = '#22c55e'; c.fillRect(130, 72, 14, 14);
        c.fillStyle = '#3b82f6'; c.fillRect(112, 90, 14, 14);
        c.fillStyle = '#eab308'; c.fillRect(130, 90, 14, 14);

        c.strokeStyle = '#09090b'; c.lineWidth = 3;
        c.strokeRect(112, 72, 32, 32);
      } else {
        // Fallback when no AI lantern art came back (generation failure, older bundle, etc).
        // Classic Dungeon Glowing Crystal Sconce
        // Iron Bracket
        c.fillStyle = '#18181b';
        c.fillRect(120, 102, 16, 24);
        c.fillRect(112, 98, 32, 6);
        c.fillStyle = '#3f3f46';
        c.fillRect(112, 98, 32, 2);

        // Glowing Core
        const glowGrad = c.createLinearGradient(128, 50, 128, 98);
        glowGrad.addColorStop(0, '#fef08a');
        glowGrad.addColorStop(0.4, '#f59e0b');
        glowGrad.addColorStop(1, '#b45309');
        c.fillStyle = glowGrad;
        
        c.beginPath();
        c.moveTo(128, 50);
        c.lineTo(144, 75);
        c.lineTo(136, 98);
        c.lineTo(120, 98);
        c.lineTo(112, 75);
        c.closePath();
        c.fill();
        
        c.strokeStyle = '#fde047';
        c.lineWidth = 2;
        c.stroke();
      }

      wallLanternTexture = c.getImageData(0, 0, TEX_SIZE, TEX_SIZE);
    }

    // Average colour of a wall/floor texture, so the stairwell below can be cut from the same
    // stone as the dungeon it sits in rather than being one fixed grey in every theme.
    function averageTextureColor(imgData, fallback = { r: 122, g: 118, b: 112 }) {
      if (!imgData || !imgData.data) return fallback;
      const d = imgData.data;
      let r = 0, g = 0, b = 0, n = 0;
      // Every 64th pixel is plenty for a mean and keeps this off the frame budget.
      for (let i = 0; i < d.length; i += 4 * 64) {
        r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
      }
      if (!n) return fallback;
      return { r: r / n, g: g / n, b: b / n };
    }

    // The exit used to be a floating "End" placard. It is a STAIRWELL now: a stone opening cut
    // into the far wall of the exit cell with steps descending away into the dark.
    //
    // Drawn in one-point perspective and anchored to the FLOOR at render time (see the exit
    // pass in render3D), not centred on the horizon the way the placard was. That is what makes
    // it read as a hole in the world instead of a sign hanging in one: the nearest step edge
    // meets the floor line of the exit cell, and each step further down is drawn thinner,
    // narrower and darker, converging on a vanishing point just under eye level - which is
    // exactly where descending steps go.
    //
    // The 256x128 canvas is authored at the aspect the renderer will draw it at (one cell wide
    // by ~0.92 of a wall tall, which works out near 2:1 at every distance because both scale as
    // 1/d), so the steps are not squashed on screen.
    const EXIT_SPR_W = 256, EXIT_SPR_H = 128;
    // How much of a wall's height the stairwell opening takes, measured up from the floor.
    // 0.92 leaves a course of stone above the lintel rather than running into the ceiling.
    const EXIT_STAIRS_WALL_FRAC = 0.92;
    function buildExitStairsTexture(styleName = "Windows 95", sourceWallImageData = null) {
      const cv = document.createElement('canvas');
      cv.width = EXIT_SPR_W;
      cv.height = EXIT_SPR_H;
      const c = cv.getContext('2d');
      c.imageSmoothingEnabled = false;
      c.clearRect(0, 0, EXIT_SPR_W, EXIT_SPR_H);

      // Normalise the sampled wall to a fixed, fairly dark luminance. Sampling alone gives a
      // pastel stairwell in a bright theme and a black one in a dark theme; renormalising keeps
      // the dungeon's HUE while pinning the tone, so the stairs read as shadowed stone whatever
      // the walls are made of.
      const raw = averageTextureColor(sourceWallImageData);
      const luma = 0.2126 * raw.r + 0.7152 * raw.g + 0.0722 * raw.b;
      const norm = luma > 8 ? 118 / luma : 1;
      const base = { r: raw.r * norm, g: raw.g * norm, b: raw.b * norm };
      // m scales the stone; tint blends it towards the warm light spilling down the stairwell.
      const stone = (m, tint = 0, a = 1) => {
        const t = Math.max(0, Math.min(1, tint)) * 0.5;
        const r = Math.min(255, base.r * m * (1 - t) + 255 * t);
        const g = Math.min(255, base.g * m * (1 - t) + 238 * t);
        const b = Math.min(255, base.b * m * (1 - t) + 200 * t);
        return `rgba(${r | 0},${g | 0},${b | 0},${a})`;
      };

      // --- The opening. Its top edge is the lintel of the arch, its bottom edge is the floor.
      // Filled with deep shadow rather than pure black so the corners the flight does not reach
      // read as the stairwell's own unlit walls instead of holes punched in the world.
      const JAMB = 18;                    // stone left and right of the opening
      const LINTEL = 14;                  // stone above it
      const openL = JAMB, openR = EXIT_SPR_W - JAMB, openT = LINTEL, openB = EXIT_SPR_H;
      const cx = EXIT_SPR_W / 2;
      const voidGrad = c.createLinearGradient(0, openB, 0, openT);
      voidGrad.addColorStop(0, stone(0.10));
      voidGrad.addColorStop(1, stone(0.30));
      c.fillStyle = voidGrad;
      c.fillRect(openL, openT, openR - openL, openB - openT);

      // --- The flight. Step 0 is nearest, at the bottom, spanning the full opening; each one
      // after is shorter (foreshortening compresses the treads), narrower (the walls converge)
      // and BRIGHTER - the stairs climb out of the dungeon towards daylight, which is also what
      // makes them legible from the far end of a dark corridor.
      const STEPS = 14;
      const geom = [];                     // remembered for the side walls below
      let y = EXIT_SPR_H;                  // front edge of the nearest step
      let stepH = 23;                      // its on-screen height
      let halfW = (openR - openL) / 2;
      for (let i = 0; i < STEPS && stepH > 0.6; i++) {
        const nextHalfW = halfW * 0.908;
        const top = y - stepH;
        // How far up the flight this step is. Squared-ish so the brightening reads as light
        // falling from one place rather than a flat ramp.
        const up = Math.pow(i / (STEPS - 1), 1.4);

        geom.push({ y, halfW });

        // Tread - the flat you would step on, narrowing as it recedes.
        c.fillStyle = stone(0.52 + up * 0.58, up * 0.85);
        c.beginPath();
        c.moveTo(cx - halfW, y);
        c.lineTo(cx + halfW, y);
        c.lineTo(cx + nextHalfW, top);
        c.lineTo(cx - nextHalfW, top);
        c.closePath();
        c.fill();

        // Riser - the vertical face under the step's front edge, always in its own shadow.
        // It is what reads as "step" rather than "stripe".
        const riserH = Math.max(1, stepH * 0.34);
        c.fillStyle = stone(0.18 + up * 0.30, up * 0.25);
        c.beginPath();
        c.moveTo(cx - halfW, y);
        c.lineTo(cx + halfW, y);
        c.lineTo(cx + halfW * 0.997, y - riserH);
        c.lineTo(cx - halfW * 0.997, y - riserH);
        c.closePath();
        c.fill();

        // Lit nosing along the front edge, catching the light from above.
        c.fillStyle = stone(0.85 + up * 0.5, up, 0.9);
        c.fillRect(cx - halfW, y - riserH - 1, halfW * 2, 1.4);

        y = top;
        stepH *= 0.812;
        halfW = nextHalfW;
      }

      // --- Side walls, following the flight up. Drawn as one polygon per side from the
      // opening's edge to each step's outer corner, so the treads are bounded by stone all the
      // way up instead of ending in a black wedge.
      const flightTop = y, flightHalfW = halfW;
      for (const side of [-1, 1]) {
        const wallGrad = c.createLinearGradient(0, EXIT_SPR_H, 0, flightTop);
        wallGrad.addColorStop(0, stone(0.20));
        wallGrad.addColorStop(1, stone(0.46, 0.30));
        c.fillStyle = wallGrad;
        c.beginPath();
        c.moveTo(cx + side * (openR - openL) / 2, EXIT_SPR_H);
        c.lineTo(cx + side * (openR - openL) / 2, openT);
        c.lineTo(cx + side * flightHalfW, flightTop);
        for (let i = geom.length - 1; i >= 0; i--) {
          c.lineTo(cx + side * geom[i].halfW, geom[i].y);
        }
        c.closePath();
        c.fill();
      }

      // --- The light the stairs climb towards. Sits at the top of the flight and spills a
      // little way back down it, which is what tells the player these go OUT rather than
      // deeper in - and makes the exit findable from the dark end of a long corridor.
      const glowR = (openR - openL) * 0.5;
      const glow = c.createRadialGradient(cx, flightTop + 2, 1, cx, flightTop + 2, glowR);
      glow.addColorStop(0, 'rgba(255,242,214,0.92)');
      glow.addColorStop(0.35, 'rgba(255,232,186,0.42)');
      glow.addColorStop(1, 'rgba(255,226,170,0)');
      c.fillStyle = glow;
      c.fillRect(openL, openT, openR - openL, EXIT_SPR_H - openT);

      // --- Stone surround. Painted LAST and only outside the opening, so the arch frames the
      // hole rather than being drawn over by it.
      c.fillStyle = stone(0.78);
      c.fillRect(0, 0, openL, EXIT_SPR_H);                       // left jamb
      c.fillRect(openR, 0, EXIT_SPR_W - openR, EXIT_SPR_H);      // right jamb
      c.fillRect(0, 0, EXIT_SPR_W, openT);                       // lintel
      // Bevel: lit on top and left, shadowed on the inner reveal, which is what gives the
      // opening depth instead of reading as a black rectangle painted on the wall.
      c.fillStyle = stone(1.18, 0.9);
      c.fillRect(0, 0, EXIT_SPR_W, 3);
      c.fillRect(0, 0, 3, EXIT_SPR_H);
      c.fillStyle = stone(0.42, 0.95);
      c.fillRect(openL - 3, openT - 3, (openR - openL) + 6, 3);  // under the lintel
      c.fillRect(openL - 3, openT, 3, EXIT_SPR_H - openT);       // inner reveal, left
      c.fillRect(openR, openT, 3, EXIT_SPR_H - openT);           // inner reveal, right

      // Block courses across the surround, so the frame reads as masonry at a glance.
      c.fillStyle = stone(0.55, 0.75);
      for (let by = 10; by < EXIT_SPR_H; by += 22) {
        c.fillRect(0, by, openL - 3, 1.5);
        c.fillRect(openR + 3, by, EXIT_SPR_W - openR - 3, 1.5);
      }

      exitStairsTexture = c.getImageData(0, 0, EXIT_SPR_W, EXIT_SPR_H);
    }

    // Full-cell wall texture for a closed door (MAP tile 3). Uses the style-matched AI slab
    // (aiDoorImg) when it decoded, otherwise paints a procedural banded slab over the wall.
    function buildDoorTexture(baseWallImageData, styleName = "Windows 95") {
      if (aiDoorImg && aiDoorImg.complete && aiDoorImg.naturalWidth > 0) {
        doorTexture = imageToTexture(aiDoorImg);
        return;
      }
      const cv = document.createElement('canvas');
      cv.width = cv.height = TEX_SIZE;
      const c = cv.getContext('2d');
      c.imageSmoothingEnabled = false;
      if (baseWallImageData) c.putImageData(baseWallImageData, 0, 0);
      else { c.fillStyle = '#3f3f46'; c.fillRect(0, 0, TEX_SIZE, TEX_SIZE); }

      const isWin95 = styleName.toLowerCase().includes('windows');
      const S = TEX_SIZE;
      const m = 18;                                   // stone jamb margin

      // recessed doorway
      c.fillStyle = isWin95 ? '#6b7280' : '#1f2937';
      c.fillRect(m, m, S - 2 * m, S - 2 * m);

      // planks
      const px = m + 8, pw = S - 2 * m - 16, planks = 4;
      const plankW = pw / planks;
      for (let i = 0; i < planks; i++) {
        c.fillStyle = isWin95
          ? (i % 2 ? '#9ca3af' : '#7d8590')
          : (i % 2 ? '#5b4632' : '#4a3826');
        c.fillRect(px + i * plankW, m + 8, plankW - 2, S - 2 * m - 16);
      }

      // iron bands
      c.fillStyle = isWin95 ? '#334155' : '#27272a';
      c.fillRect(m + 4, m + 30, S - 2 * m - 8, 14);
      c.fillRect(m + 4, S - m - 44, S - 2 * m - 8, 14);

      // ring handle
      c.strokeStyle = isWin95 ? '#1e293b' : '#18181b';
      c.lineWidth = 7;
      c.beginPath(); c.arc(S / 2 + 34, S / 2, 20, 0, Math.PI * 2); c.stroke();
      // keyhole plate
      c.fillStyle = isWin95 ? '#1e293b' : '#18181b';
      c.fillRect(S / 2 + 24, S / 2 + 24, 16, 22);
      c.fillStyle = isWin95 ? '#0f172a' : '#000000';
      c.beginPath(); c.arc(S / 2 + 32, S / 2 + 31, 4, 0, Math.PI * 2); c.fill();
      c.fillRect(S / 2 + 31, S / 2 + 31, 3, 10);

      // frame outline
      c.strokeStyle = isWin95 ? '#e2e8f0' : '#111827';
      c.lineWidth = 4;
      c.strokeRect(m, m, S - 2 * m, S - 2 * m);

      doorTexture = c.getImageData(0, 0, TEX_SIZE, TEX_SIZE);
    }

    // The opened gate (MAP tile 6). A door that vanished on unlocking used to leave the player
    // no evidence a gate had ever been there, so an opened one keeps the jamb - but the leaf
    // itself is just gone, not swung open against a post: a swung leaf is drawn edge-on this
    // close up (the doorway is only ever seen face-on or from the crossing corridor - see the
    // per-column ray-segment pass in render3D), which reads as a random sliver of door
    // material jammed in the opening rather than as a door standing open. Erasing it entirely
    // reads as "open" at every angle, with no geometry that can look wrong.
    //
    // Every pixel comes from doorTexture - the closed door - so whatever style the generator
    // returned, the open gate's jamb matches it with no second piece of art to generate.
    // Sampled from the vertical band the wall renderer actually shows (the texTop crop in
    // render3D) so the open jamb lines up with the closed door it replaces.
    function buildOpenDoorTexture() {
      if (!doorTexture) { doorOpenTexture = null; return; }

      const bandY = Math.round((TEX_SIZE * (1 - WALL_HEIGHT)) / 2);
      const bandH = Math.round(TEX_SIZE * WALL_HEIGHT);

      const src = document.createElement('canvas');
      src.width = src.height = TEX_SIZE;
      src.getContext('2d').putImageData(doorTexture, 0, 0);

      const cv = document.createElement('canvas');
      cv.width = DOOR_SPR_W; cv.height = DOOR_SPR_H;
      const c = cv.getContext('2d');
      c.imageSmoothingEnabled = false;

      const post = Math.round(DOOR_SPR_W * 0.13);      // side jamb thickness
      const lintel = Math.round(DOOR_SPR_H * 0.12);    // head jamb thickness
      const openW = DOOR_SPR_W - 2 * post;
      const openH = DOOR_SPR_H - lintel;               // opening runs down to the floor

      // Punching a plain rectangle here left the closed door's own arched top (whatever
      // curve the generated art actually drew) hanging as a solid chunk above a flat-topped
      // hole - a doorway that reads as "the wall opened," not as a door-shaped cutout. So the
      // hole itself is an arch: straight jambs up to the springline, then a rounded top - a
      // reasonable universal doorway silhouette given the closed art's real curve isn't known
      // (it's a plain opaque generated image, no alpha to trace).
      const archH = Math.min(openH * 0.38, openW * 0.55);
      const springY = lintel + archH;
      const archCx = post + openW / 2;
      function archPath() {
        c.beginPath();
        c.moveTo(post, lintel + openH);
        c.lineTo(post, springY);
        c.ellipse(archCx, springY, openW / 2, archH, 0, Math.PI, 2 * Math.PI, false);
        c.lineTo(post + openW, lintel + openH);
        c.closePath();
      }

      // The closed door's visible band, with the arch-shaped opening punched out of it ->
      // jamb ring, no leaf.
      c.drawImage(src, 0, bandY, TEX_SIZE, bandH, 0, 0, DOOR_SPR_W, DOOR_SPR_H);
      archPath();
      c.globalCompositeOperation = 'destination-out';
      c.fill();
      c.globalCompositeOperation = 'source-over';

      // Dark reveals down the inside of each post + a shadow under the arch, so the opening
      // reads as a threshold with depth rather than a hole cut flat into the wall. Clipped to
      // the same arch path so the shading can't paint into the solid spandrels above the curve.
      c.save();
      archPath();
      c.clip();

      const reveal = c.createLinearGradient(post, 0, post + openW, 0);
      reveal.addColorStop(0, 'rgba(0, 0, 0, 0.55)');
      reveal.addColorStop(0.13, 'rgba(0, 0, 0, 0)');
      reveal.addColorStop(0.87, 'rgba(0, 0, 0, 0)');
      reveal.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
      c.fillStyle = reveal;
      c.fillRect(post, lintel, openW, openH);

      const head = c.createLinearGradient(0, lintel, 0, springY);
      head.addColorStop(0, 'rgba(0, 0, 0, 0.5)');
      head.addColorStop(1, 'rgba(0, 0, 0, 0)');
      c.fillStyle = head;
      c.fillRect(post, lintel, openW, archH);

      c.restore();

      doorOpenTexture = c.getImageData(0, 0, DOOR_SPR_W, DOOR_SPR_H);
    }

    // OFF/ON wall textures for a switch (MAP tiles 4 and 5). No colour and no light tell
    // them apart - not a tint on the fixture, not a lamp/indicator dot, nothing additive.
    // The only difference is the fixture's own pose, from two SEPARATELY generated pieces of
    // art (aiSwitchImg / aiSwitchOnImg - see get_gate_prompts on the server, which asks for
    // the same plate and materials with the handle down vs. thrown, explicitly unlit in
    // both). If either failed to decode, BOTH poses fall back to one procedural rendering
    // path together (never mixing a real photo for one state with a drawn shape for the
    // other) - a fixed plate and pivot with a lever that swings between two fully contained
    // positions, drawn in the exact same colour regardless of state.
    //
    // The fixture is deliberately small and chunky - the AI cutout is downsampled to SWITCH_SRC
    // px before being blown back up with smoothing off - so it sits in the wall at roughly
    // lantern scale and at the wall texture's own resolution, instead of floating over it as a
    // smooth high-res decal.
    function buildSwitchWallTextures(baseWallImageData, styleName = "Windows 95") {
      const haveOff = aiSwitchImg && aiSwitchImg.complete && aiSwitchImg.naturalWidth > 0;
      const haveOn = aiSwitchOnImg && aiSwitchOnImg.complete && aiSwitchOnImg.naturalWidth > 0;
      const haveArt = haveOff && haveOn;
      const isWin95 = styleName.toLowerCase().includes('windows');

      const cx = 128;                 // fixture centre on the wall
      const baseY = 142;              // where the fixture's bottom edge sits
      const maxW = 34, maxH = 56;     // fixture footprint
      const SWITCH_SRC = 24;          // chunky-pixel source size for the AI cutout

      // Downsamples one pose's AI cutout to its own small canvas, fit to the SAME maxW/maxH
      // box the other pose uses - so two independently generated images with slightly
      // different framing still land at a matched scale.
      function prepArt(img) {
        const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
        const fw = Math.max(1, Math.round(img.naturalWidth * scale));
        const fh = Math.max(1, Math.round(img.naturalHeight * scale));
        const longest = Math.max(fw, fh);
        const sw = Math.max(1, Math.round(SWITCH_SRC * (fw / longest)));
        const sh = Math.max(1, Math.round(SWITCH_SRC * (fh / longest)));
        const small = document.createElement('canvas');
        small.width = sw; small.height = sh;
        const sc = small.getContext('2d');
        sc.imageSmoothingEnabled = true;
        sc.drawImage(img, 0, 0, sw, sh);
        return { small, fw, fh };
      }

      const offArt = haveArt ? prepArt(aiSwitchImg) : null;
      const onArt = haveArt ? prepArt(aiSwitchOnImg) : null;

      function renderPose(on) {
        const c = document.createElement('canvas');
        c.width = c.height = TEX_SIZE;
        const ctx2 = c.getContext('2d');
        ctx2.imageSmoothingEnabled = false;
        if (baseWallImageData) ctx2.putImageData(baseWallImageData, 0, 0);

        if (haveArt) {
          const art = on ? onArt : offArt;
          ctx2.drawImage(art.small, cx - art.fw / 2, baseY - art.fh, art.fw, art.fh);
        } else {
          // Fixed plate + pivot, identical for both states.
          ctx2.fillStyle = isWin95 ? '#94a3b8' : '#27272a';
          ctx2.fillRect(cx - 11, baseY - 34, 22, 34);
          ctx2.strokeStyle = isWin95 ? '#475569' : '#3f3f46';
          ctx2.lineWidth = 2;
          ctx2.strokeRect(cx - 11, baseY - 34, 22, 34);

          // Lever: one colour in both states, resting down-left for OFF and thrown up-right
          // for ON around the same pivot - position is the only thing that changes.
          const pivotY = baseY - 17;
          const leverColor = isWin95 ? '#b91c1c' : '#a1a1aa';
          const tipX = on ? cx + 9 : cx - 9;
          const tipY = on ? pivotY - 13 : pivotY + 13;
          ctx2.strokeStyle = leverColor;
          ctx2.lineWidth = 5;
          ctx2.beginPath(); ctx2.moveTo(cx, pivotY); ctx2.lineTo(tipX, tipY); ctx2.stroke();
          ctx2.fillStyle = leverColor;
          ctx2.beginPath(); ctx2.arc(tipX, tipY, 4, 0, Math.PI * 2); ctx2.fill();

          ctx2.fillStyle = '#52525b';
          ctx2.beginPath(); ctx2.arc(cx, pivotY, 4, 0, Math.PI * 2); ctx2.fill();
        }

        return ctx2.getImageData(0, 0, TEX_SIZE, TEX_SIZE);
      }

      switchWallOffTexture = renderPose(false);
      switchWallOnTexture = renderPose(true);
    }

    // ==========================================
    // LOCKED GATES + SWITCHES  (placed during maze generation)
    // ==========================================
    function _tileKey(x, y) { return x + ',' + y; }

    // In-place Fisher-Yates. braidMaze picks which loops to carve by shuffling the full
    // candidate list and taking a prefix, rather than sampling at random with replacement -
    // the same wall can't be drawn twice, so a budget of N carves really is N carves.
    function _shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    }

    const _ORTHO =[{ dx: 0, dy: -1 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 1, dy: 0 }];
    const _NEIGHBORS8 = _ORTHO.concat([
      { dx: -1, dy: -1 }, { dx: 1, dy: -1 }, { dx: -1, dy: 1 }, { dx: 1, dy: 1 }
    ]);

    // Used by the lantern pass below: true if (x,y) touches a still-closed door (3) or a
    // switch (4/5) tile, including diagonally - a torch crowding the archway looks cluttered,
    // and worse, one beside a switch lights up a fixture placeGatesAndSwitches specifically
    // put off the beaten path to be hard to spot.
    function _nearGateOrSwitch(x, y) {
      for (const d of _NEIGHBORS8) {
        const nx = x + d.dx, ny = y + d.dy;
        if (ny < 0 || ny >= MAP_HEIGHT || nx < 0 || nx >= MAP_WIDTH) continue;
        const v = MAP[ny][nx];
        if (v === 3 || v === 4 || v === 5) return true;
      }
      return false;
    }

    // Shortest path over MAP===0 tiles. In a perfect (spanning-tree) maze there is exactly
    // one simple path, so this IS the start->exit route. Returns [{x,y}, ...] or null.
    function _bfsPath(a, b) {
      const prev = new Map();
      prev.set(_tileKey(a.x, a.y), null);
      const queue = [{ x: a.x, y: a.y }];
      let qi = 0;
      while (qi < queue.length) {
        const cur = queue[qi++];
        if (cur.x === b.x && cur.y === b.y) break;
        for (const d of _ORTHO) {
          const nx = cur.x + d.dx, ny = cur.y + d.dy;
          if (ny < 0 || ny >= MAP_HEIGHT || nx < 0 || nx >= MAP_WIDTH) continue;
          if (MAP[ny][nx] !== 0) continue;
          const k = _tileKey(nx, ny);
          if (prev.has(k)) continue;
          prev.set(k, cur);
          queue.push({ x: nx, y: ny });
        }
      }
      if (!prev.has(_tileKey(b.x, b.y))) return null;
      const out = [];
      let node = { x: b.x, y: b.y };
      while (node) { out.push(node); node = prev.get(_tileKey(node.x, node.y)); }
      out.reverse();
      return out;
    }

    // Flood fill from seed over tiles where passableFn(x,y) is true. Returns
    // Map("x,y" -> {x, y, dist}).
    function _flood(seed, passableFn) {
      const out = new Map();
      const start = { x: seed.x, y: seed.y, dist: 0 };
      out.set(_tileKey(seed.x, seed.y), start);
      const queue = [start];
      let qi = 0;
      while (qi < queue.length) {
        const cur = queue[qi++];
        for (const d of _ORTHO) {
          const nx = cur.x + d.dx, ny = cur.y + d.dy;
          if (ny < 0 || ny >= MAP_HEIGHT || nx < 0 || nx >= MAP_WIDTH) continue;
          const k = _tileKey(nx, ny);
          if (out.has(k) || !passableFn(nx, ny)) continue;
          const e = { x: nx, y: ny, dist: cur.dist + 1 };
          out.set(k, e);
          queue.push(e);
        }
      }
      return out;
    }

    // Phase 1 of gating: choose WHERE the 1-3 locked doors go, while the maze is still a
    // spanning tree and the start->exit path is therefore unique. That uniqueness is what makes
    // "evenly spaced along the route" mean anything, so this has to run before braidMaze() adds
    // loops. Returns null when the maze is too small to gate (the caller then places no doors
    // and no switches, exactly as before), otherwise a plan braidMaze() must protect and
    // placeGatesAndSwitches() then stamps.
    function planGates() {
      const path = _bfsPath(startRoom, exitRoom);
      if (!path || path.length < 2) return null;
      const L = path.length - 1;
      if (L < 8) return null;                             // too short to gate comfortably

      // Roughly one gate per 30 steps of route, still capped at 3 and still bounded by how many
      // connector tiles there are to sit on. This used to be a flat min(3, ...), which handed a
      // 33-tile Easy maze the same three doors as a 111-tile Hard one - a gate every ten tiles.
      // That matters more than it looks: braidMaze can only carve loops WITHIN a gate region, so
      // three doors chop a small maze into four ~4-cell pockets with no room for a loop in any of
      // them. Measured over 400 Easy mazes, three gates left 37% of them still perfect (zero
      // loops); one gate leaves 3%. Medium and Hard are big enough that it barely moves them
      // (12.0 vs 12.8 loops on Hard), so this is really about not over-gating the small maps.
      const connectorCount = Math.floor(L / 2);
      let N = Math.min(3, Math.floor(connectorCount / 2), Math.max(1, Math.round(L / 30)));
      if (N < 1) return null;

      // door path-indices: evenly spaced, odd (connector tiles), strictly increasing with a
      // gap >= 2, and at least one cell of slack before the first / after the last.
      const doorIdx = [];
      for (let i = 1; i <= N; i++) {
        let t = Math.round((i * L) / (N + 1));
        if (t % 2 === 0) t -= 1;
        const lo = 1 + 2 * i;
        const hi = (L - 1) - 2 * (N - i);
        if (lo > hi) continue;
        t = Math.max(lo, Math.min(hi, t));
        if (doorIdx.length && t <= doorIdx[doorIdx.length - 1] + 1) {
          t = doorIdx[doorIdx.length - 1] + 2;
        }
        if (t % 2 === 1 && t >= 1 && t <= L - 1 &&
            (!doorIdx.length || t > doorIdx[doorIdx.length - 1])) {
          doorIdx.push(t);
        }
      }
      if (!doorIdx.length) return null;

      const gates = doorIdx.map((t, k) => {
        const prevC = path[t - 1], nextC = path[t + 1];
        return {
          tile: path[t],
          // The path cell the player stands on when this gate blocks them. Switch hosts are
          // scored by distance from here, so a lever never sits in the cell facing its door.
          approach: prevC,
          // Seed for the region the player is confined to until this gate opens: the start for
          // the first door, the cell just past the previous door for the rest.
          seed: (k === 0) ? path[0] : path[doorIdx[k - 1] + 1],
          // Which way the corridor runs through this connector - prevC and nextC are exactly
          // the two cells it joins. Same y (differ in x): an east-west corridor, so the door's
          // OWN plane spans north-south - axis 'y'. Same x: plane spans east-west - axis 'x'.
          // Used by the open-gate render pass to draw the doorway as a properly oriented
          // segment instead of a camera-facing billboard, so it foreshortens correctly (and
          // looks edge-on, not full-width) when glimpsed from a crossing passage. Braiding
          // cannot invalidate this: a connector tile's other two neighbours are (even,even)
          // corner tiles, which nothing ever carves.
          axis: (prevC.y === nextC.y) ? 'y' : 'x',
          // Slice of `path` strictly between this gate's region seed and the gate itself, for
          // the last-resort switch host below.
          lowIdx: (k === 0) ? 2 : doorIdx[k - 1] + 1,
          hiIdx: t - 1
        };
      });

      // Region 0 is everything before door 0; region k+1 starts at the cell just past door k.
      // braidMaze() uses these to label the maze before it carves anything.
      const regionSeeds = [path[0]].concat(doorIdx.map((t) => path[t + 1]));
      return { path, gates, regionSeeds };
    }

    // Phase 2: turn the spanning tree into a MULTICURSAL maze by knocking out extra walls, so
    // corridors rejoin each other instead of every passage having exactly one way in and out.
    // Two passes - dead-end braiding (give a tip a second exit, which makes the corridor that
    // led there into a circuit) and a scatter of cross-corridor shortcuts, which is what stops
    // a long snaking passage from still being a long snaking passage once its tips are tied off.
    //
    // The one thing braiding must NOT do is hand the player a way around a locked gate. Every
    // planned door tile is a cut tile of the tree: it separates the region the player is stuck
    // in from everything past it. So label every floor cell with its gate region (doors treated
    // as walls), then only ever carve BETWEEN TWO CELLS OF THE SAME REGION. Adding edges inside
    // a region can never connect one region to another, so all N doors stay mandatory and
    // placeGatesAndSwitches' solvability proof survives unchanged.
    // Returns the region label map, which relocateExit() needs to keep the Exit behind the
    // last gate.
    function braidMaze(cellRows, cellCols, plan) {
      const regionOf = new Map();
      if (plan) {
        const blocked = new Set(plan.gates.map((g) => _tileKey(g.tile.x, g.tile.y)));
        plan.regionSeeds.forEach((seed, id) => {
          _flood(seed, (x, y) => MAP[y][x] === 0 && !blocked.has(_tileKey(x, y)))
            .forEach((e, key) => { if (!regionOf.has(key)) regionOf.set(key, id); });
        });
      }
      const sameRegion = (a, b) => {
        if (!plan) return true;
        const ra = regionOf.get(_tileKey(a.x, a.y));
        return ra !== undefined && ra === regionOf.get(_tileKey(b.x, b.y));
      };
      // The Exit stays a cul-de-sac in both passes: a shortcut opening straight into it would
      // both shorten the run and cost the arrival its "you found it" beat.
      const isExit = (x, y) => x === exitRoom.x && y === exitRoom.y;

      // Every wall sitting between two carved cells that could legally come out. Only down and
      // right are considered so each wall is enumerated exactly once.
      const candidates = [];
      const byCell = new Map();
      let cellCount = 0;
      for (let r = 0; r < cellRows; r++) {
        for (let c = 0; c < cellCols; c++) {
          const y = r * 2 + 1, x = c * 2 + 1;
          if (MAP[y][x] !== 0) continue;                  // a cell the carve never reached
          cellCount++;
          for (const d of [{ dr: 1, dc: 0 }, { dr: 0, dc: 1 }]) {
            const nr = r + d.dr, nc = c + d.dc;
            if (nr >= cellRows || nc >= cellCols) continue;
            const ny = nr * 2 + 1, nx = nc * 2 + 1;
            if (MAP[ny][nx] !== 0) continue;              // ditto for the neighbour
            const wy = y + d.dr, wx = x + d.dc;
            if (MAP[wy][wx] !== 1) continue;              // that wall is already an opening
            const a = { x, y }, b = { x: nx, y: ny };
            if (!sameRegion(a, b)) continue;              // would bypass a gate - never carve
            const cand = { wx, wy, a, b };
            candidates.push(cand);
            for (const key of [_tileKey(x, y), _tileKey(nx, ny)]) {
              if (!byCell.has(key)) byCell.set(key, []);
              byCell.get(key).push(cand);
            }
          }
        }
      }

      const floorNbCount = (x, y) => {
        let n = 0;
        for (const d of _ORTHO) {
          const ny = y + d.dy, nx = x + d.dx;
          if (ny >= 0 && ny < MAP_HEIGHT && nx >= 0 && nx < MAP_WIDTH && MAP[ny][nx] === 0) n++;
        }
        return n;
      };

      // Pass 1 - dead ends. A cell with one open neighbour is a tip; opening a second wall
      // turns the passage that led to it into a loop. Capped at MAZE.braidDeadEnds so enough
      // tips survive for placeGatesAndSwitches to hide levers down.
      const deadEnds = [];
      for (let r = 0; r < cellRows; r++) {
        for (let c = 0; c < cellCols; c++) {
          const y = r * 2 + 1, x = c * 2 + 1;
          if (MAP[y][x] === 0 && !isExit(x, y) && floorNbCount(x, y) <= 1) deadEnds.push({ x, y });
        }
      }
      _shuffle(deadEnds);
      const braidTarget = Math.round(deadEnds.length * MAZE.braidDeadEnds);
      let braided = 0;
      for (const de of deadEnds) {
        if (braided >= braidTarget) break;
        if (floorNbCount(de.x, de.y) > 1) continue;       // an earlier braid already opened it
        const opts = (byCell.get(_tileKey(de.x, de.y)) || [])
          .filter((o) => MAP[o.wy][o.wx] === 1 && !isExit(o.a.x, o.a.y) && !isExit(o.b.x, o.b.y));
        if (!opts.length) continue;
        const pick = opts[Math.floor(Math.random() * opts.length)];
        MAP[pick.wy][pick.wx] = 0;
        braided++;
      }

      // Pass 2 - shortcuts across the middle of long corridors, which is what gives a route a
      // choice partway along it rather than only where a dead end used to be.
      _shuffle(candidates);
      let cut = 0;
      const extraTarget = Math.round(cellCount * MAZE.extraLoops);
      for (const cand of candidates) {
        if (cut >= extraTarget) break;
        if (MAP[cand.wy][cand.wx] !== 1) continue;        // pass 1 already took this one
        if (isExit(cand.a.x, cand.a.y) || isExit(cand.b.x, cand.b.y)) continue;
        MAP[cand.wy][cand.wx] = 0;
        cut++;
      }
      return regionOf;
    }

    // The Exit is meant to be the hardest tile in the maze to get to, and up to here it is
    // whichever cell the carve reached last by tree depth. Braiding invalidates that: a
    // shortcut between two corridors can cut a big chunk off the walk without touching the
    // exit cell itself, and measured over 250 hard mazes that alone knocked the start->exit
    // route from 92 steps down to 67. So re-pick it on the FINISHED map - the tile genuinely
    // furthest from the spawn now that every loop exists.
    //
    // Restricted to the region past the last gate, which is what keeps all N doors standing
    // between the player and the Exit; the gates were planned against the old exit, and moving
    // it around inside the final region cannot put it in front of any of them.
    function relocateExit(plan, regionOf) {
      const lastId = plan ? plan.regionSeeds.length - 1 : 0;
      // Doors are not stamped yet, so this floods the maze as it will be with every gate open -
      // i.e. the real walking distance once the player has earned their way through.
      const dist = _flood(startRoom, (x, y) => MAP[y][x] === 0);
      let best = null, bestScore = -1;
      dist.forEach((e, key) => {
        if (e.x % 2 !== 1 || e.y % 2 !== 1) return;         // cells only, never a connector
        if (plan && regionOf.get(key) !== lastId) return;
        let floorNb = 0;
        for (const d of _ORTHO) {
          const nx = e.x + d.dx, ny = e.y + d.dy;
          if (ny >= 0 && ny < MAP_HEIGHT && nx >= 0 && nx < MAP_WIDTH && MAP[ny][nx] === 0) floorNb++;
        }
        // Distance is the point; the dead-end nudge only breaks ties between tiles that are
        // already about as far out as each other, so the Exit still tends to sit at the end of
        // something rather than in the middle of a thoroughfare.
        const score = e.dist * 4 + (floorNb <= 1 ? 6 : 0);
        if (score > bestScore) { bestScore = score; best = { x: e.x, y: e.y }; }
      });
      if (best) exitRoom = best;
    }

    // Phase 3: stamp the planned doors and, for each, find one wall switch the player can
    // PROVABLY reach before that door (sequential gating). Guarantee: switch_k lies in the
    // region reachable with doors 0..k-1 open, so the player opens them in order and always
    // finishes. Braiding does not weaken this - it only ever adds corridors WITHIN a region,
    // which can make a switch easier to walk to but never moves it behind its own gate. Fills
    // doorList / switchList and stamps MAP (3 = closed door, 4 = switch OFF).
    function placeGatesAndSwitches(plan) {
      doorList = [];
      switchList = [];
      if (!plan) return;

      const gates = plan.gates;
      const N = gates.length;

      // The route the player actually walks now that the maze has loops in it. Every gate tile
      // is still a cut tile (see braidMaze), so this passes through all of them in order - but
      // it is no longer the pre-braid path, and it is THIS one the host scorer has to treat as
      // "the main route", or a lever scored as off-path could land on the corridor the player
      // was going to take anyway.
      const path = plan.path;
      const route = _bfsPath(startRoom, exitRoom) || path;
      const pathTiles = new Set(route.map((c) => _tileKey(c.x, c.y)));

      const usedCells = new Set();

      for (let k = 0; k < N; k++) {
        const g = gates[k];
        const d = g.tile;
        const seed = g.seed;

        // doors k..N-1 are still shut in this state; earlier doors are stamped MAP===3 and
        // therefore also block the flood, which only tightens the region (still safe).
        const blocked = new Set();
        for (let j = k; j < N; j++) blocked.add(_tileKey(gates[j].tile.x, gates[j].tile.y));
        const region = _flood(seed, (x, y) => MAP[y][x] === 0 && !blocked.has(_tileKey(x, y)));

        // Distance of every region tile from the door's approach tile (the path cell the
        // player stands on when the gate blocks them). Used to push the switch away from
        // the gate it opens - a lever mounted in the cell facing the door is no puzzle,
        // the player never has to leave the corridor to find it.
        const approach = g.approach;
        const doorDist = _flood(approach, (x, y) => MAP[y][x] === 0 && !blocked.has(_tileKey(x, y)));

        // host cell: an (odd,odd) floor tile in the region, not start/exit, unused, with a
        // solid wall to mount on. Wants it well clear of the door, off the start->exit path
        // (so reaching it costs a real detour) and ideally down a dead end.
        let best = null, bestScore = -1;
        const pickHost = (minDoorDist) => {
          best = null; bestScore = -1;
          region.forEach((e) => {
            if (e.x % 2 !== 1 || e.y % 2 !== 1) return;
            if (e.x === startRoom.x && e.y === startRoom.y) return;
            if (e.x === exitRoom.x && e.y === exitRoom.y) return;
            if (usedCells.has(_tileKey(e.x, e.y))) return;
            const dEntry = doorDist.get(_tileKey(e.x, e.y));
            if (!dEntry || dEntry.dist < minDoorDist) return;
            let wallNb = 0, floorNb = 0;
            for (const dl of _ORTHO) {
              const nx = e.x + dl.dx, ny = e.y + dl.dy;
              if (ny < 0 || ny >= MAP_HEIGHT || nx < 0 || nx >= MAP_WIDTH) continue;
              if (MAP[ny][nx] === 1) wallNb++;
              else if (MAP[ny][nx] === 0) floorNb++;
            }
            if (wallNb === 0) return;
            const dd = dEntry.dist;
            const offPath = !pathTiles.has(_tileKey(e.x, e.y));
            const score = (offPath ? 60 : 0)                  // side passage, not the main route
                        + (floorNb <= 1 ? 25 : 0)             // dead end
                        + (dd <= 20 ? 40 : 0)                 // far, but not a slog back to the gate
                        + Math.min(dd, 20) * 4
                        + e.dist;                             // tie-break: deeper from the seed
            if (score > bestScore) { bestScore = score; best = { x: e.x, y: e.y }; }
          });
        };

        // 6 tiles = three cells clear of the gate. Relax only when the reachable region is
        // too cramped to honour it, so tiny mazes still get a solvable switch.
        pickHost(6);
        if (!best) pickHost(4);
        if (!best) pickHost(2);
        if (!best) pickHost(0);

        // fallback: a path cell strictly between the seed and this door, furthest from the
        // door first for the same reason.
        if (!best) {
          for (let t = g.lowIdx; t <= g.hiIdx; t++) {
            const c = path[t];
            if (c.x % 2 !== 1 || c.y % 2 !== 1) continue;
            if (usedCells.has(_tileKey(c.x, c.y))) continue;
            let wallNb = 0;
            for (const dl of _ORTHO) {
              const nx = c.x + dl.dx, ny = c.y + dl.dy;
              if (ny >= 0 && ny < MAP_HEIGHT && nx >= 0 && nx < MAP_WIDTH && MAP[ny][nx] === 1) wallNb++;
            }
            if (wallNb > 0) { best = { x: c.x, y: c.y }; break; }
          }
        }
        if (!best) continue;                               // cannot gate safely -> skip door

        // wall tile for the switch: a solid neighbour of the host cell. Prefer the wall
        // opposite the single entrance (the "back wall" of a dead end), and prefer non-border.
        const floorDirs = [];
        for (const dl of _ORTHO) {
          const nx = best.x + dl.dx, ny = best.y + dl.dy;
          if (ny >= 0 && ny < MAP_HEIGHT && nx >= 0 && nx < MAP_WIDTH && MAP[ny][nx] === 0) floorDirs.push(dl);
        }
        const wallCandidates = [];
        for (const dl of _ORTHO) {
          const nx = best.x + dl.dx, ny = best.y + dl.dy;
          if (ny < 0 || ny >= MAP_HEIGHT || nx < 0 || nx >= MAP_WIDTH) continue;
          if (MAP[ny][nx] !== 1) continue;
          const border = (nx === 0 || ny === 0 || nx === MAP_WIDTH - 1 || ny === MAP_HEIGHT - 1);
          const opposite = floorDirs.length === 1 &&
            dl.dx === -floorDirs[0].dx && dl.dy === -floorDirs[0].dy;
          wallCandidates.push({ x: nx, y: ny, rank: (opposite ? 0 : 1) + (border ? 2 : 0) });
        }
        if (!wallCandidates.length) continue;
        wallCandidates.sort((p, q) => p.rank - q.rank);
        const wall = wallCandidates[0];

        MAP[d.y][d.x] = 3;
        MAP[wall.y][wall.x] = 4;

        // Doorway orientation was worked out by planGates from the two cells this connector
        // joins - see the `axis` note there for what it means and why braiding cannot change it.
        doorList.push({ x: d.x, y: d.y, index: k, opened: false, axis: g.axis });
        switchList.push({
          x: wall.x, y: wall.y, cellX: best.x, cellY: best.y, doorIndex: k, on: false
        });
        usedCells.add(_tileKey(best.x, best.y));
      }
    }

        // ==========================================
    // AUTHENTIC 3DMAZE GENERATOR (GOLDEN STANDARD - EXACT TILES)
    // ==========================================
    function generateAuthentic3DMaze(numGrids = DIFFICULTIES.medium.grids) {
      numGrids = Math.max(10, Math.min(MAX_GRIDS, numGrids));

      // Calculate target cells to reach exactly (or close to) numGrids total walkable tiles.
      // Since total tiles = cells + (cells - 1) = 2 * cells - 1
      const targetCells = Math.max(2, Math.ceil((numGrids + 1) / 2));

      // Create a bounding box large enough to let the DFS wander organically
      const cellCols = Math.max(3, Math.ceil(Math.sqrt(targetCells * 1.5)));
      const cellRows = Math.max(3, Math.ceil(targetCells / cellCols) + 1);

      MAP_WIDTH = cellCols * 2 + 1;
      MAP_HEIGHT = cellRows * 2 + 1;

      MAP = Array(MAP_HEIGHT).fill(0).map(() => Array(MAP_WIDTH).fill(1));
      lanternList = [];
      doorList = [];
      switchList = [];

      const visitedCells = Array(cellRows).fill(0).map(() => Array(cellCols).fill(false));
      const stack = [];
      
      const startR = Math.floor(cellRows / 2);
      const startC = Math.floor(cellCols / 2);
      const startCell = { r: startR, c: startC };
      
      visitedCells[startR][startC] = true;
      MAP[startR * 2 + 1][startC * 2 + 1] = 0;
      stack.push(startCell);

      let visitedCount = 1;
      let maxDist = 0;
      let furthestCell = { r: startR, c: startC };
      const distances = Array(cellRows).fill(0).map(() => Array(cellCols).fill(0));

      while (stack.length > 0 && visitedCount < targetCells) {
        // Growing-tree selection (see MAZE.branchChance). Always taking the newest frontier
        // cell IS the recursive backtracker; taking a random one some of the time keeps several
        // corridors advancing at once, so the finished maze has junctions spread through it
        // rather than one committed passage that only forks when it hits a wall.
        const pick = (stack.length > 1 && Math.random() < MAZE.branchChance)
          ? Math.floor(Math.random() * stack.length)
          : stack.length - 1;
        const current = stack[pick];
        const neighbors = [];

        const deltas = [
          { dr: -1, dc: 0 },
          { dr: 1, dc: 0 },
          { dr: 0, dc: -1 },
          { dr: 0, dc: 1 }
        ];

        for (const d of deltas) {
          const nr = current.r + d.dr;
          const nc = current.c + d.dc;
          if (nr >= 0 && nr < cellRows && nc >= 0 && nc < cellCols && !visitedCells[nr][nc]) {
            neighbors.push({ r: nr, c: nc, dr: d.dr, dc: d.dc });
          }
        }

        if (neighbors.length > 0) {
          const next = neighbors[Math.floor(Math.random() * neighbors.length)];
          const wallY = current.r * 2 + 1 + next.dr;
          const wallX = current.c * 2 + 1 + next.dc;
          const nextY = next.r * 2 + 1;
          const nextX = next.c * 2 + 1;

          MAP[wallY][wallX] = 0;
          MAP[nextY][nextX] = 0;

          visitedCells[next.r][next.c] = true;
          distances[next.r][next.c] = distances[current.r][current.c] + 1;
          visitedCount++;

          if (distances[next.r][next.c] > maxDist) {
            maxDist = distances[next.r][next.c];
            furthestCell = { r: next.r, c: next.c };
          }

          stack.push({ r: next.r, c: next.c });
        } else {
          stack.splice(pick, 1);          // not necessarily the top any more - see `pick` above
        }
      }

      startRoom = { x: startC * 2 + 1, y: startR * 2 + 1 };
      exitRoom = { x: furthestCell.c * 2 + 1, y: furthestCell.r * 2 + 1 };

      // Gating and loop-carving are interleaved, and the order is load-bearing:
      //   planGates()  picks the door tiles while the maze is still a tree and the start->exit
      //                route is therefore unique - which is what "evenly spaced along it" means.
      //   braidMaze()  adds the loops that make the maze multicursal, refusing any carve that
      //                would join two different gate regions, so every planned door stays a
      //                mandatory cut tile rather than something you can walk around.
      //   placeGates.. stamps the doors and hunts down switch hosts on the FINISHED map, so a
      //                lever is scored against the route the player will really take.
      // All three run BEFORE the lantern pass (which only touches MAP===1, so it skips our
      // door/switch tiles) and BEFORE passagesList is built (so a closed door is correctly
      // excluded from the walkable-tile count, and the loop tiles are correctly included).
      const gatePlan = planGates();
      const gateRegions = braidMaze(cellRows, cellCols, gatePlan);
      relocateExit(gatePlan, gateRegions);
      placeGatesAndSwitches(gatePlan);

      // Add Lanterns to Walls - never beside a door or switch (see _nearGateOrSwitch above).
      for (let y = 1; y < MAP_HEIGHT - 1; y++) {
        for (let x = 1; x < MAP_WIDTH - 1; x++) {
          if (MAP[y][x] === 1) {
            const hasAdjacentFloor = (MAP[y-1][x] === 0 || MAP[y+1][x] === 0 || MAP[y][x-1] === 0 || MAP[y][x+1] === 0);
            if (hasAdjacentFloor && (x + y) % 3 === 0 && !_nearGateOrSwitch(x, y)) {
              MAP[y][x] = 2;
              lanternList.push({ x, y });
            }
          }
        }
      }

      passagesList = [];
      for (let y = 1; y < MAP_HEIGHT - 1; y++) {
        for (let x = 1; x < MAP_WIDTH - 1; x++) {
          if (MAP[y][x] === 0) {
            passagesList.push({ x, y });
          }
        }
      }

      // Needs the finished passagesList - and the finished gates, since a marker parked on a
      // door tile would be unreachable until its switch was thrown.
      placeEnemyMarkers();

      // GUARANTEE player spawns facing the OPEN corridor (never facing a wall!)
      let spawnDir = 1;
      if (MAP[startRoom.y] && MAP[startRoom.y][startRoom.x + 1] === 0) spawnDir = 1;
      else if (MAP[startRoom.y + 1] && MAP[startRoom.y + 1][startRoom.x] === 0) spawnDir = 2;
      else if (MAP[startRoom.y] && MAP[startRoom.y][startRoom.x - 1] === 0) spawnDir = 3;
      else if (MAP[startRoom.y - 1] && MAP[startRoom.y - 1][startRoom.x] === 0) spawnDir = 0;

      player.gridX = startRoom.x;
      player.gridY = startRoom.y;
      player.dirIndex = spawnDir;
      player.posX = startRoom.x + 0.5;
      player.posY = startRoom.y + 0.5;
      player.angle = dirToAngle(spawnDir);
      player.isAnimating = false;

      visitedTiles.clear();
      visitedTiles.add(`${startRoom.x},${startRoom.y}`);
      totalMoves = 0;
      queuedAction = null;

      if (mapProgressBadge) {
        mapProgressBadge.textContent = `${visitedTiles.size}/${passagesList.length} Tiles`;
      }
    }

    // Scatter the dungeon's foes over its corridors.
    //
    // Rules, in the order they matter:
    //   - never the spawn tile, never the exit tile (the exit ends the run the moment it is
    //     stepped on, so a fight there could never resolve), and nothing within 2 tiles of the
    //     spawn - the player gets a corridor's worth of dungeon before the first ambush.
    //   - markers keep 2 tiles between them, so a cleared stretch stays cleared and a corridor
    //     never turns into a gauntlet of three back-to-back fights.
    //   - the BOSS does not roam. It is placed first, on the walkable tiles immediately
    //     adjacent to the exit - one, or two where the exit has two ways in - so the last
    //     thing between the player and the stairs is always the dread foe. Everything that
    //     roams is a walker or a flyer.
    // Density is ~1 foe per 6 tiles, floored at 4 so even the smallest maze is worth fighting
    // through, capped at 14 so a huge one doesn't become a slog. The guards count towards it.
    const MARKER_MIN_SPACING = 2;
    const MAX_EXIT_GUARDS = 2;
    function placeEnemyMarkers() {
      enemyMarkers = [];
      activeMarker = null;
      if (!passagesList.length) return;

      const target = Math.max(4, Math.min(14, Math.round(passagesList.length * 0.16)));
      const far = (a, bx, by) => Math.abs(a.x - bx) + Math.abs(a.y - by);
      const walkable = new Set(passagesList.map(p => `${p.x},${p.y}`));
      const push = (x, y, variant) =>
        enemyMarkers.push({ x, y, variant, alive: true, phase: Math.random() * Math.PI * 2 });

      // --- The exit guard(s). The exit is normally the far dead end of the maze, so this is
      // usually a single boss standing in the only corridor that reaches it - unavoidable, and
      // visible from down that corridor because markerScaleFor draws it half again as large as
      // anything else. Braiding can leave the exit with a second approach; both get a guard, so
      // the stairs cannot be reached around the back.
      // The spawn tile is excluded on the off chance a small maze puts the two next to each
      // other - being ambushed by the boss before taking a step is not a fight, it is a wall.
      const approaches = [{ x: exitRoom.x + 1, y: exitRoom.y }, { x: exitRoom.x - 1, y: exitRoom.y },
                          { x: exitRoom.x, y: exitRoom.y + 1 }, { x: exitRoom.x, y: exitRoom.y - 1 }]
        .filter(p => walkable.has(`${p.x},${p.y}`) &&
                     !(p.x === startRoom.x && p.y === startRoom.y));
      _shuffle(approaches);
      approaches.slice(0, MAX_EXIT_GUARDS).forEach(p => push(p.x, p.y, 'boss'));

      // --- The roaming foes fill the rest of the maze around them.
      const candidates = passagesList.filter(p =>
        !(p.x === startRoom.x && p.y === startRoom.y) &&
        !(p.x === exitRoom.x && p.y === exitRoom.y) &&
        far(p, startRoom.x, startRoom.y) > 2
      );
      _shuffle(candidates);

      // The roaming mix. The lone walker stays the most common thing in a corridor; the lone
      // flyer and the two packs split the rest, so a dungeon of a dozen markers holds roughly
      // four walkers, three flyers, three swarms and two wings.
      //
      // This runs the INSTANT "Create" is clicked - generateAuthentic3DMaze() is synchronous
      // and happens well before the ComfyUI bundle (and its walker/flyer art) comes back, so
      // enemyVariantImgs here is either empty (a session's first dungeon) or still holding the
      // PREVIOUS dungeon's sprites. It used to gate swarmer/circler on enemyFramesFor(k) right
      // here, "only let a pack roam if its base sprite exists" - which on a first dungeon is
      // always false, silently dropping both out of the bag before a single marker was placed.
      // Walker/flyer never had that problem because nothing gated them on sprite-readiness at
      // all - the sprite swap-in just catches up by the time the player can reach a marker, and
      // v6_krea (the only engine mode left) always ships all three base variants. Packs get the
      // same free ride: pickEnemyVariant() re-checks enemyFramesFor() at the moment a fight
      // actually starts - long after the bundle has landed - and downgrades a pack to its full
      // size base variant there if it ever genuinely has no sprite to recolour, so no readiness
      // check belongs here.
      const ROAM_WEIGHTS = { walker: 4, flyer: 3, swarmer: 3, circler: 2 };
      const roamBag = [];
      for (const [k, w] of Object.entries(ROAM_WEIGHTS)) {
        for (let i = 0; i < w; i++) roamBag.push(k);
      }

      for (const p of candidates) {
        if (enemyMarkers.length >= target) break;
        if (enemyMarkers.some(m => far(p, m.x, m.y) < MARKER_MIN_SPACING)) continue;
        push(p.x, p.y, roamBag[Math.floor(Math.random() * roamBag.length)]);
      }
      updateProgressionHUD();
    }

    // The sprite a marker shows in the corridor: that variant's idle frame when the bundle
    // generated one, else whatever single enemy sprite the mode shipped. Null falls through to
    // the procedural sigil in drawWorldEnemies.
    function markerFrameFor(variant) {
      const set = enemyFramesFor(variant);
      if (set && set.idle && set.idle.complete && set.idle.naturalWidth > 0) return set.idle;
      const fallback = enemySpriteFrames[0];
      if (fallback && fallback.complete && fallback.naturalWidth > 0) return fallback;
      return null;
    }

    // ==========================================
    // 3D RAYCASTER RENDERER + 3D EXIT SIGN
    // ==========================================
    function render3D() {
      if (!wallTexture || !ceilingTexture || !floorTexture) return;

      const fov = Math.PI / 3;
      const halfFov = fov / 2;
      const pAngle = player.angle;

      const dirX = Math.cos(pAngle);
      const dirY = Math.sin(pAngle);

      // The camera sits back from the player's cell centre rather than on it. Movement is grid
      // based, so a faced wall would otherwise always be exactly 0.5 away and tower over the
      // screen. Setting the camera back pushes that wall to ~0.9 without shortening the walls
      // themselves - which is what keeps corridors looking tall while still leaving ceiling and
      // floor visible when the player is right up against something. Shortening walls alone
      // (the first attempt) bought the headroom at the cost of a squashed, crawlspace-looking
      // corridor. The camera stays inside the current cell, so raycasting is unaffected.
      const posX = player.posX - dirX * CAMERA_SETBACK;
      const posY = player.posY - dirY * CAMERA_SETBACK;
      const planeX = -dirY * Math.tan(halfFov);
      const planeY = dirX * Math.tan(halfFov);

      // Floor & Ceiling Casting
      for (let y = 0; y < screenHeight; y++) {
        const isFloor = y > screenHeight / 2;
        const p = isFloor ? (y - screenHeight / 2) : (screenHeight / 2 - y);
        if (p === 0) continue;

        // Eye level sits at half the wall height, so this has to track WALL_HEIGHT or the floor and
        // ceiling planes stop meeting the walls where they should.
        const posZ = (WALL_HEIGHT / 2) * screenHeight;
        const rowDist = posZ / p;

        const stepX = rowDist * (planeX * 2) / screenWidth;
        const stepY = rowDist * (planeY * 2) / screenWidth;

        let floorX = posX + rowDist * (dirX - planeX);
        let floorY = posY + rowDist * (dirY - planeY);

        const tex = isFloor ? floorTexture : ceilingTexture;
        const texData = tex.data;

        for (let x = 0; x < screenWidth; x++) {
          // See SURFACE_TEXELS. One texture per map cell; the mask wraps at the cell boundary.
          const tx = Math.floor(floorX * SURFACE_TEXELS) & (TEX_SIZE - 1);
          const ty = Math.floor(floorY * SURFACE_TEXELS) & (TEX_SIZE - 1);

          let lanternLight = 0;
          for (let li = 0; li < lanternList.length; li++) {
            const lx = lanternList[li].x + 0.5;
            const ly = lanternList[li].y + 0.5;
            const d = Math.hypot(floorX - lx, floorY - ly);
            if (d < 2.8) {
              lanternLight += (1.0 - d / 2.8) * 0.65;
            }
          }

          floorX += stepX;
          floorY += stepY;

          const tIdx = (ty * TEX_SIZE + tx) * 4;
          const pIdx = (y * screenWidth + x) * 4;
          const baseShade = Math.max(0.35, Math.min(1.0, 1.0 - (rowDist * 0.15)));
          const finalShade = Math.min(1.0, baseShade + lanternLight);

          buffer[pIdx] = Math.min(255, texData[tIdx] * finalShade + (lanternLight * 25));
          buffer[pIdx + 1] = Math.min(255, texData[tIdx + 1] * finalShade + (lanternLight * 15));
          buffer[pIdx + 2] = Math.min(255, texData[tIdx + 2] * finalShade);
          buffer[pIdx + 3] = 255;
        }
      }

      // Wall Casting
      for (let x = 0; x < screenWidth; x++) {
        const cameraX = (2 * x) / screenWidth - 1;
        const rayDirX = dirX + planeX * cameraX;
        const rayDirY = dirY + planeY * cameraX;

        let mapX = Math.floor(posX);
        let mapY = Math.floor(posY);

        let sideDistX, sideDistY;
        const deltaDistX = Math.abs(1 / (rayDirX === 0 ? 1e-6 : rayDirX));
        const deltaDistY = Math.abs(1 / (rayDirY === 0 ? 1e-6 : rayDirY));
        let perpWallDist;

        let stepX, stepY;
        let hit = 0;
        let side = 0;

        if (rayDirX < 0) {
          stepX = -1;
          sideDistX = (posX - mapX) * deltaDistX;
        } else {
          stepX = 1;
          sideDistX = (mapX + 1.0 - posX) * deltaDistX;
        }

        if (rayDirY < 0) {
          stepY = -1;
          sideDistY = (posY - mapY) * deltaDistY;
        } else {
          stepY = 1;
          sideDistY = (mapY + 1.0 - posY) * deltaDistY;
        }

        while (hit === 0) {
          if (sideDistX < sideDistY) {
            sideDistX += deltaDistX;
            mapX += stepX;
            side = 0;
          } else {
            sideDistY += deltaDistY;
            mapY += stepY;
            side = 1;
          }
          if (mapX < 0 || mapX >= MAP_WIDTH || mapY < 0 || mapY >= MAP_HEIGHT) {
            hit = 1;
            break;
          }
          // 6 is an opened gate: walkable and see-through, so the ray passes it and the
          // doorway is drawn as a sprite in the open-gate pass below.
          const cell = MAP[mapY][mapX];
          if (cell > 0 && cell !== 6) hit = cell;
        }

        if (side === 0) perpWallDist = (mapX - posX + (1 - stepX) / 2) / rayDirX;
        else perpWallDist = (mapY - posY + (1 - stepY) / 2) / rayDirY;

        perpWallDist = Math.max(0.1, perpWallDist);
        zBuffer[x] = perpWallDist;

        // True perspective, just with shorter walls - see WALL_HEIGHT.
        const lineHeight = Math.floor((screenHeight * WALL_HEIGHT) / perpWallDist);
        let drawStart = Math.floor(-lineHeight / 2 + screenHeight / 2);
        let drawEnd = Math.floor(lineHeight / 2 + screenHeight / 2);

        const clampedStart = Math.max(0, drawStart);
        const clampedEnd = Math.min(screenHeight - 1, drawEnd);

        let wallX;
        if (side === 0) wallX = posY + perpWallDist * rayDirY;
        else wallX = posX + perpWallDist * rayDirX;
        wallX -= Math.floor(wallX);

        let texX = Math.floor(wallX * TEX_SIZE);
        if (side === 0 && rayDirX > 0) texX = TEX_SIZE - texX - 1;
        if (side === 1 && rayDirY < 0) texX = TEX_SIZE - texX - 1;

        let wallTexToUse = wallTexture;
        if (hit === 2 && wallLanternTexture) wallTexToUse = wallLanternTexture;
        else if (hit === 3 && doorTexture) wallTexToUse = doorTexture;
        else if (hit === 4 && switchWallOffTexture) wallTexToUse = switchWallOffTexture;
        else if (hit === 5 && switchWallOnTexture) wallTexToUse = switchWallOnTexture;
        const wallData = wallTexToUse.data;

        let wallLanternLight = 0;
        const wallWorldX = side === 0 ? mapX : (posX + perpWallDist * rayDirX);
        const wallWorldY = side === 1 ? mapY : (posY + perpWallDist * rayDirY);

        for (let li = 0; li < lanternList.length; li++) {
          const lx = lanternList[li].x + 0.5;
          const ly = lanternList[li].y + 0.5;
          const d = Math.hypot(wallWorldX - lx, wallWorldY - ly);
          if (d < 3.2) {
            wallLanternLight += (1.0 - d / 3.2) * 0.75;
          }
        }

        const sideShade = side === 1 ? 0.82 : 1.0;
        const distShade = 1.0 / (1.0 + perpWallDist * 0.38);
        const lanternSelfGlow = (hit === 2) ? 0.35 : 0;
        // No switchGlow term here - an ON switch is shaded like any other wall tile; the
        // fixture's pose is the only difference from OFF, per buildSwitchWallTextures.
        const finalShade = Math.min(1.0, (sideShade * distShade) + wallLanternLight + lanternSelfGlow);

        // Walls keep v3's density of one texture per world unit HORIZONTALLY (texX above is
        // unchanged), but are now only WALL_HEIGHT tall - so squeezing the whole texture in
        // vertically compressed it by 0.62 and made bark and brick read as 1.6x too wide. Showing
        // only WALL_HEIGHT of the texture instead makes texels square again. Centring the crop
        // keeps wall-mounted detail (the lantern sconce sits around y=50-126) fully in frame.
        const step = (TEX_SIZE * WALL_HEIGHT) / lineHeight;
        const texTop = (TEX_SIZE * (1 - WALL_HEIGHT)) / 2;
        let texPos = texTop + (clampedStart - screenHeight / 2 + lineHeight / 2) * step;

        for (let y = clampedStart; y <= clampedEnd; y++) {
          const texY = Math.min(TEX_SIZE - 1, Math.max(0, Math.floor(texPos)));
          texPos += step;

          const tIdx = (texY * TEX_SIZE + texX) * 4;
          const pIdx = (y * screenWidth + x) * 4;

          buffer[pIdx] = Math.min(255, wallData[tIdx] * finalShade + (wallLanternLight * 35));
          buffer[pIdx + 1] = Math.min(255, wallData[tIdx + 1] * finalShade + (wallLanternLight * 20));
          buffer[pIdx + 2] = Math.min(255, wallData[tIdx + 2] * finalShade);
          buffer[pIdx + 3] = 255;
        }
      }

      // The exit stairwell, standing in the middle of the exit cell.
      //
      // FLOOR-anchored, not horizon-centred like the "End" placard this replaced. A hole in the
      // ground has to meet the ground: its bottom edge sits on the exit cell's floor line and it
      // rises from there, so the flight recedes UP the screen towards the vanishing point the
      // same way the corridor floor does. Centring it on the horizon (the placard's anchoring)
      // left it hanging in the air with corridor visible underneath.
      //
      // Width is one full map cell rather than a ratio of the height. A lateral world unit at
      // depth d covers screenWidth / (2*tan(halfFov)*d) pixels - the horizontal twin of the
      // screenHeight/d the wall pass uses vertically - so this makes the stone surround meet
      // the cell's own side walls at every distance instead of drifting with it.
      if (exitStairsTexture) {
        const spriteX = (exitRoom.x + 0.5) - posX;
        const spriteY = (exitRoom.y + 0.5) - posY;

        const invDet = 1.0 / (planeX * dirY - dirX * planeY);
        const transformX = invDet * (dirY * spriteX - dirX * spriteY);
        const transformY = invDet * (-planeY * spriteX + planeX * spriteY);

        if (transformY > 0.1) {
          const spriteScreenX = (screenWidth / 2) * (1 + transformX / transformY);
          const wallH = (screenHeight * WALL_HEIGHT) / transformY;
          const spriteWidth = (screenWidth / (2 * Math.tan(halfFov))) / transformY;
          const spriteHeight = wallH * EXIT_STAIRS_WALL_FRAC;
          // Bottom edge on the floor line of the cell the stairwell stands in.
          const floorY = screenHeight / 2 + wallH / 2;
          const topY = floorY - spriteHeight;
          const leftX = spriteScreenX - spriteWidth / 2;

          const drawStartY = Math.max(0, Math.floor(topY));
          const drawEndY = Math.min(screenHeight - 1, Math.ceil(floorY));
          const drawStartX = Math.max(0, Math.floor(leftX));
          const drawEndX = Math.min(screenWidth - 1, Math.ceil(leftX + spriteWidth));

          const signData = exitStairsTexture.data;
          // A touch of the wall pass's distance falloff, so the stairwell belongs to the
          // corridor rather than glowing at full brightness the way the old placard did. Only
          // a touch: this thing is lit from BEYOND the opening, not by the dungeon, and it is
          // the one landmark the player is looking for down a long dark hall. Shading it like
          // masonry (the walls' 0.38 falloff, no floor) turned it into a black rectangle at
          // three tiles and lost the exit entirely.
          const exitShade = Math.max(0.78, 1.0 / (1.0 + transformY * 0.16));

          for (let stripe = drawStartX; stripe <= drawEndX; stripe++) {
            const texX = Math.floor(((stripe - leftX) * EXIT_SPR_W) / spriteWidth);
            if (texX < 0 || texX >= EXIT_SPR_W) continue;
            // Same per-column depth test the walls wrote, so a stairwell glimpsed past a corner
            // is cut off by the corner rather than drawn over it.
            if (transformY >= zBuffer[stripe]) continue;

            for (let y = drawStartY; y <= drawEndY; y++) {
              const texY = Math.floor(((y - topY) * EXIT_SPR_H) / spriteHeight);
              if (texY < 0 || texY >= EXIT_SPR_H) continue;

              const sIdx = (texY * EXIT_SPR_W + texX) * 4;
              const alpha = signData[sIdx + 3] / 255;
              if (alpha <= 0.05) continue;

              const pIdx = (y * screenWidth + stripe) * 4;
              buffer[pIdx] = Math.floor(buffer[pIdx] * (1 - alpha) + signData[sIdx] * exitShade * alpha);
              buffer[pIdx + 1] = Math.floor(buffer[pIdx + 1] * (1 - alpha) + signData[sIdx + 1] * exitShade * alpha);
              buffer[pIdx + 2] = Math.floor(buffer[pIdx + 2] * (1 - alpha) + signData[sIdx + 2] * exitShade * alpha);
            }
          }
        }
      }

      // Open gates (MAP tile 6): a fixed planar segment across the doorway, NOT a camera-
      // facing billboard - a billboard always shows its full face no matter the viewing
      // angle, which looked wrong (rotated 90deg from how a real doorway would read) when
      // glimpsed from a crossing passage instead of straight down the door's own corridor.
      // Each screen column intersects the ray it already cast against the door's world-space
      // segment directly - same per-column exactness as the DDA wall pass above, so this
      // foreshortens correctly (full width head-on, edge-on from the side) with no fisheye
      // distortion and no affine texture warp to approximate away.
      if (doorOpenTexture && doorList.length) {
        const gData = doorOpenTexture.data;
        const NEAR = 0.2;

        for (const d of doorList) {
          if (!d.opened) continue;
          // Segment endpoints from the axis computed in placeGatesAndSwitches: 'x' spans
          // east-west across the tile at its vertical midline, 'y' spans north-south at its
          // horizontal midline.
          const p1x = d.axis === 'x' ? d.x : d.x + 0.5;
          const p1y = d.axis === 'x' ? d.y + 0.5 : d.y;
          const ex = d.axis === 'x' ? 1 : 0;
          const ey = d.axis === 'x' ? 0 : 1;
          const Ax = p1x - posX, Ay = p1y - posY;

          for (let x = 0; x < screenWidth; x++) {
            const cameraX = 2 * x / screenWidth - 1;
            const rdx = dirX + planeX * cameraX;
            const rdy = dirY + planeY * cameraX;

            // Ray (posX,posY)+t*(rdx,rdy) meets segment p1+s*(ex,ey): solve the 2x2 system.
            const det = ex * rdy - ey * rdx;
            if (Math.abs(det) < 1e-6) continue;             // ray runs parallel to the door
            const t = (-Ax * ey + ex * Ay) / det;
            if (t <= NEAR || t >= zBuffer[x]) continue;     // behind camera, or wall-occluded
            const s = (rdx * Ay - rdy * Ax) / det;
            if (s < 0 || s > 1) continue;                   // ray misses the doorway's extent

            const texX = Math.min(DOOR_SPR_W - 1, Math.max(0, Math.floor(s * DOOR_SPR_W)));
            const spriteH = (screenHeight * WALL_HEIGHT) / t;   // same formula as a wall column
            const topY = screenHeight / 2 - spriteH / 2;
            const startY = Math.max(0, Math.floor(topY));
            const endY = Math.min(screenHeight - 1, Math.ceil(topY + spriteH));
            const shade = 1.0 / (1.0 + t * 0.38);

            for (let y = startY; y <= endY; y++) {
              const texY = Math.floor(((y - topY) * DOOR_SPR_H) / spriteH);
              if (texY < 0 || texY >= DOOR_SPR_H) continue;
              const sIdx = (texY * DOOR_SPR_W + texX) * 4;
              const alpha = gData[sIdx + 3] / 255;
              if (alpha <= 0.05) continue;
              const pIdx = (y * screenWidth + x) * 4;
              buffer[pIdx]     = Math.min(255, buffer[pIdx]     * (1 - alpha) + gData[sIdx]     * shade * alpha);
              buffer[pIdx + 1] = Math.min(255, buffer[pIdx + 1] * (1 - alpha) + gData[sIdx + 1] * shade * alpha);
              buffer[pIdx + 2] = Math.min(255, buffer[pIdx + 2] * (1 - alpha) + gData[sIdx + 2] * shade * alpha);
            }
          }
        }
      }

      ctx.putImageData(imgData, 0, 0);

      // Roaming foes, drawn only out of battle - once a fight starts the duel owns the frame
      // and the marker the player is standing on would just be underfoot.
      if (!combatState.inBattle) {
        drawWorldEnemies(ctx, posX, posY, dirX, dirY, planeX, planeY);
      }

      // Render 3D Combat Entities
      drawCombatEnemy(ctx, screenWidth, screenHeight);
      drawOverTheShoulderPlayer(ctx, screenWidth, screenHeight);
      drawCombatEffects(ctx);
    }

    // render3D used to end with drawInteractHint(ctx): a small "E : USE" / "LOCKED" / "THROWN"
    // label at the bottom of the screen whenever the player faced a door or switch tile.
    // Removed - it told the player a wall segment was interactive, and for a switch whether
    // it was already thrown, before they'd actually spotted the fixture themselves, which
    // undercut the same puzzle the switch-placement distance and the minimap change further
    // up exist to protect. Interacting is still fully discoverable from the door and switch
    // textures alone; it's just not spelled out in text anymore. interact() below dropped its
    // floating "IT'S LOCKED" / "ALREADY THROWN" / "THE GATE GRINDS OPEN" text for the same
    // reason, keeping only the sound cues and the fixtures' own visual state change.

    // ==========================================
    // MINIMAP & NAVIGATION (FOG OF WAR)
    // ==========================================
    const minimapCanvas = document.getElementById('minimapCanvas');
    const minimapCtx = minimapCanvas ? minimapCanvas.getContext('2d') : null;

    function drawMinimap() {
      if (!minimapCtx || passagesList.length === 0) return;
      const c = minimapCtx;
      c.fillStyle = '#000000';
      c.fillRect(0, 0, minimapCanvas.width, minimapCanvas.height);

      visitedTiles.add(`${player.gridX},${player.gridY}`);
      if (mapProgressBadge) {
        mapProgressBadge.textContent = `${visitedTiles.size}/${passagesList.length} Tiles`;
      }

      const tileSize = passagesList.length > 50 ? 14 : (passagesList.length > 25 ? 18 : 22);
      const centerX = minimapCanvas.width / 2;
      const centerY = minimapCanvas.height / 2;

      const offsetX = centerX - player.posX * tileSize;
      const offsetY = centerY - player.posY * tileSize;

      visitedTiles.forEach(vKey => {
        const [vx, vy] = vKey.split(',').map(Number);
        const rx = offsetX + vx * tileSize;
        const ry = offsetY + vy * tileSize;

        const isCurrent = (vx === player.gridX && vy === player.gridY);
        const isExit = (vx === exitRoom.x && vy === exitRoom.y);

        c.fillStyle = isCurrent ? '#16a34a' : (isExit ? '#eab308' : '#2563eb');
        c.fillRect(rx, ry, tileSize, tileSize);

        if (isExit) {
          c.fillStyle = '#000000';
          c.font = `bold ${Math.max(8, tileSize - 6)}px sans-serif`;
          c.textAlign = 'center';
          c.textBaseline = 'middle';
          c.fillText('★', rx + tileSize / 2, ry + tileSize / 2);
        }

        const adj = [
          { x: vx, y: vy - 1 },
          { x: vx, y: vy + 1 },
          { x: vx - 1, y: vy },
          { x: vx + 1, y: vy }
        ];

        adj.forEach(w => {
          if (w.x < 0 || w.x >= MAP_WIDTH || w.y < 0 || w.y >= MAP_HEIGHT) return;
          const mv = MAP[w.y][w.x];
          if (mv < 1) return;
          const wx = offsetX + w.x * tileSize;
          const wy = offsetY + w.y * tileSize;

          // An opened gate is a passage now, not a wall - floor-coloured with the jamb left
          // as an outline, so the map shows where the gate was and that it is through.
          if (mv === 6) {
            c.fillStyle = '#2563eb';
            c.fillRect(wx, wy, tileSize, tileSize);
            c.strokeStyle = '#b45309';
            c.lineWidth = 2;
            c.strokeRect(wx + 1, wy + 1, tileSize - 2, tileSize - 2);
            return;
          }

          c.fillStyle = '#334155';
          c.fillRect(wx, wy, tileSize, tileSize);
          c.strokeStyle = '#475569';
          c.lineWidth = 0.5;
          c.strokeRect(wx, wy, tileSize, tileSize);

          if (mv === 3) {
            c.fillStyle = '#b45309';
            c.fillRect(wx + 2, wy + 2, tileSize - 4, tileSize - 4);
          }
          // Switch tiles (4/5) get no marker - they render as a plain wall, same as any other.
          // The minimap would otherwise hand the player the solution to a puzzle whose whole
          // point is that the lever is placed away from its gate and has to be found in 3D.
        });
      });

      // Player Arrow
      c.save();
      c.translate(centerX, centerY);
      c.rotate(player.angle + Math.PI / 2);
      c.fillStyle = '#ef4444';
      c.beginPath();
      c.moveTo(0, -tileSize * 0.45);
      c.lineTo(tileSize * 0.35, tileSize * 0.35);
      c.lineTo(0, tileSize * 0.15);
      c.lineTo(-tileSize * 0.35, tileSize * 0.35);
      c.closePath();
      c.fill();
      c.strokeStyle = '#ffffff';
      c.lineWidth = 1;
      c.stroke();
      c.restore();

      // Check Victory Condition
      const isExit = (player.gridX === exitRoom.x && player.gridY === exitRoom.y);
      if (isExit && victoryModal.classList.contains('hidden') && totalMoves > 0) {
        winMovesCount.textContent = totalMoves;
        playSfx('end', { vary: 0 });
        victoryModal.classList.remove('hidden');
        // Same hand-off as the death box: the dungeon's bed rides out under the 'end' sting
        // and the victory loop scores the box until the player heads back to the menu.
        fadeOutDungeonMusic(0.6);
        setTimeout(() => playScreenMusic('victory'), 700);
      }
    }

    function updateHUD() {
      if (statusPos) {
        statusPos.textContent = `Spot (${player.gridX}, ${player.gridY}) [Facing ${DIRS[player.dirIndex]}]`;
      }
    }

    function easeInOutCubic(t) {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    function animate3D(targetX, targetY, targetAngle) {
      player.isAnimating = true;
      const startX = player.posX;
      const startY = player.posY;
      const startAngle = player.angle;
      const animStart = performance.now();
      const DURATION = 160;

      function step(now) {
        const elapsed = now - animStart;
        const progress = Math.min(1.0, elapsed / DURATION);
        const ease = easeInOutCubic(progress);

        player.posX = startX + (targetX - startX) * ease;
        player.posY = startY + (targetY - startY) * ease;
        player.angle = startAngle + (targetAngle - startAngle) * ease;

        render3D();
        drawMinimap();

        if (progress < 1.0) {
          requestAnimationFrame(step);
        } else {
          player.posX = targetX;
          player.posY = targetY;
          player.angle = targetAngle;
          player.isAnimating = false;
          updateHUD();

          // Ambush check on arrival, not on the key press, so the step is seen through before
          // the room drops away and the duel slides in. startEncounter clears queuedAction, so
          // a key held down through the transition can't walk the player during the fight.
          checkEncounterAtPlayer();
          if (combatState.inBattle) return;

          if (queuedAction) {
            const next = queuedAction;
            queuedAction = null;
            if (next === 'UP') moveForward();
            else if (next === 'DOWN') moveBackward();
            else if (next === 'LEFT') rotateLeft();
            else if (next === 'RIGHT') rotateRight();
          }
        }
      }
      requestAnimationFrame(step);
    }

    function animateBump(dx, dy) {
      player.isAnimating = true;
      const startX = player.posX;
      const startY = player.posY;
      const bumpX = startX + dx * 0.18;
      const bumpY = startY + dy * 0.18;
      const animStart = performance.now();
      const OUT_DURATION = 90;
      const BACK_DURATION = 140;
      const TOTAL = OUT_DURATION + BACK_DURATION;

      function step(now) {
        const elapsed = now - animStart;

        if (elapsed < OUT_DURATION) {
          const ease = easeInOutCubic(Math.min(1, elapsed / OUT_DURATION));
          player.posX = startX + (bumpX - startX) * ease;
          player.posY = startY + (bumpY - startY) * ease;
        } else if (elapsed < TOTAL) {
          const ease = easeInOutCubic(Math.min(1, (elapsed - OUT_DURATION) / BACK_DURATION));
          player.posX = bumpX + (startX - bumpX) * ease;
          player.posY = bumpY + (startY - bumpY) * ease;
        } else {
          player.posX = startX;
          player.posY = startY;
        }

        render3D();
        drawMinimap();

        if (elapsed < TOTAL) {
          requestAnimationFrame(step);
        } else {
          player.isAnimating = false;

          if (queuedAction) {
            const next = queuedAction;
            queuedAction = null;
            if (next === 'UP') moveForward();
            else if (next === 'DOWN') moveBackward();
            else if (next === 'LEFT') rotateLeft();
            else if (next === 'RIGHT') rotateRight();
          }
        }
      }
      requestAnimationFrame(step);
    }

    // Face a tile and press Space: throw a wall switch (MAP 4 -> 5) to permanently open its door
    // (MAP 3 -> 0), or bump a still-locked door. Latching: a thrown switch stays on.
    function interact() {
      if (player.isAnimating || combatState.inBattle || inputLocked()) return;
      const vec = DIR_VECS[player.dirIndex];
      const fx = player.gridX + vec.dx;
      const fy = player.gridY + vec.dy;
      const t = (MAP[fy] && MAP[fy][fx] !== undefined) ? MAP[fy][fx] : 1;

      if (t === 4 || t === 5) {
        const sw = switchList.find(s => s.x === fx && s.y === fy);
        if (!sw) return;
        if (sw.on) return;                  // already thrown - the lever's own pose says so
        sw.on = true;
        MAP[fy][fx] = 5;
        playSfx('button', { vary: 0.06 });
        const door = doorList.find(d => d.index === sw.doorIndex);
        if (door && !door.opened) {
          door.opened = true;
          MAP[door.y][door.x] = 6;          // opened gate: walkable, still drawn as a doorway
          passagesList.push({ x: door.x, y: door.y });
          playSfx('end', { vary: 0.04, gain: 0.6 });
        }
        return;
      }

      if (t === 3) {
        playSfx('bump');                    // still shut - the door's own texture shows that
      }
    }

    // Walkable floor: open corridor (0) or an opened gate (6). Everything else - wall (1),
    // lantern (2), still-locked door (3), switch plate (4/5) - is solid.
    function isWalkable(x, y) {
      const row = MAP[y];
      if (!row) return false;
      const t = row[x];
      return t === 0 || t === 6;
    }

    function moveForward() {
      if (inputLocked() || combatState.inBattle) return;
      if (player.isAnimating) { queuedAction = 'UP'; return; }
      const vec = DIR_VECS[player.dirIndex];
      const nextX = player.gridX + vec.dx;
      const nextY = player.gridY + vec.dy;

      if (isWalkable(nextX, nextY)) {
        player.gridX = nextX;
        player.gridY = nextY;
        totalMoves++;
        playSfx('step');
        animate3D(nextX + 0.5, nextY + 0.5, player.angle);
      } else {
        playSfx('bump');
        animateBump(vec.dx, vec.dy);
      }
    }

    function moveBackward() {
      if (inputLocked() || combatState.inBattle) return;
      if (player.isAnimating) { queuedAction = 'DOWN'; return; }
      const vec = DIR_VECS[player.dirIndex];
      const nextX = player.gridX - vec.dx;
      const nextY = player.gridY - vec.dy;

      if (isWalkable(nextX, nextY)) {
        player.gridX = nextX;
        player.gridY = nextY;
        totalMoves++;
        playSfx('step', { rate: 0.94 });
        animate3D(nextX + 0.5, nextY + 0.5, player.angle);
      } else {
        playSfx('bump');
        animateBump(-vec.dx, -vec.dy);
      }
    }

    function rotateLeft() {
      if (inputLocked() || combatState.inBattle) return;
      if (player.isAnimating) { queuedAction = 'LEFT'; return; }
      player.dirIndex = (player.dirIndex + 3) % 4;
      playSfx('turn');
      animate3D(player.posX, player.posY, player.angle - Math.PI / 2);
    }

    function rotateRight() {
      if (inputLocked() || combatState.inBattle) return;
      if (player.isAnimating) { queuedAction = 'RIGHT'; return; }
      player.dirIndex = (player.dirIndex + 1) % 4;
      playSfx('turn');
      animate3D(player.posX, player.posY, player.angle + Math.PI / 2);
    }

    // ==========================================
    // EVENT LISTENERS & INITIALIZATION
    // ==========================================
    btnUp.addEventListener('pointerdown', (e) => { e.preventDefault(); moveForward(); });
    btnDown.addEventListener('pointerdown', (e) => { e.preventDefault(); moveBackward(); });
    btnLeft.addEventListener('pointerdown', (e) => { e.preventDefault(); rotateLeft(); });
    btnRight.addEventListener('pointerdown', (e) => { e.preventDefault(); rotateRight(); });
    if (btnAction) btnAction.addEventListener('pointerdown', (e) => { e.preventDefault(); interact(); });

    window.addEventListener('keydown', (e) => {
      if (screenGame.classList.contains('hidden')) return;

      // The level-up box owns the keyboard while it is up: 1/2/3 take a path outright, the
      // arrows move the cursor and Space/Enter confirms it. Nothing falls through to the
      // dungeon, and there is no key that dismisses the box without choosing.
      if (levelUpOpen) {
        e.preventDefault();
        if (e.code === 'Digit1' || e.code === 'Numpad1') applyLevelChoice('strength');
        else if (e.code === 'Digit2' || e.code === 'Numpad2') applyLevelChoice('stamina');
        else if (e.code === 'Digit3' || e.code === 'Numpad3') applyLevelChoice('survival');
        else if (['ArrowUp', 'KeyW', 'ArrowLeft', 'KeyA'].includes(e.code)) moveLevelUpSelection(-1);
        else if (['ArrowDown', 'KeyS', 'ArrowRight', 'KeyD'].includes(e.code)) moveLevelUpSelection(1);
        else if (e.code === 'Space' || e.code === 'Enter') {
          applyLevelChoice(LEVEL_CHOICE_KEYS[progression.choiceIndex]);
        }
        return;
      }

      if (combatState.inBattle) {
        // Space had been the flee key. There is no fleeing now - the fight ends when one of the
        // two goes down - but it still has to be swallowed, or it re-triggers whichever combat
        // button the pointer last left focused.
        if (e.code === 'Space') { e.preventDefault(); return; }
        if (combatState.dead) return;   // no dodging, guarding or swinging from beyond the grave
        if (['KeyA', 'ArrowLeft'].includes(e.code)) {
          e.preventDefault();
          keysHeld.left = true;
        } else if (['KeyD', 'ArrowRight'].includes(e.code)) {
          e.preventDefault();
          keysHeld.right = true;
        } else if (['KeyX', 'KeyS', 'ArrowDown', 'KeyK'].includes(e.code)) {
          e.preventDefault();
          keysHeld.block = true;
        } else if (['KeyZ', 'KeyW', 'ArrowUp', 'KeyJ'].includes(e.code)) {
          e.preventDefault();
          combatAttack();
        }
        return;
      }

      if (['ArrowUp', 'KeyW'].includes(e.code)) {
        e.preventDefault();
        moveForward();
      } else if (['ArrowDown', 'KeyS'].includes(e.code)) {
        e.preventDefault();
        moveBackward();
      } else if (['ArrowLeft', 'KeyA'].includes(e.code)) {
        e.preventDefault();
        rotateLeft();
      } else if (['ArrowRight', 'KeyD'].includes(e.code)) {
        e.preventDefault();
        rotateRight();
      } else if (e.code === 'Space' || e.code === 'Enter') {
        // Space is the Use key now. It used to toggle battle mode, which only ever existed so
        // fights could be tested; battles start by walking onto a foe in the corridor instead.
        e.preventDefault();
        interact();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (['KeyA', 'ArrowLeft'].includes(e.code)) {
        keysHeld.left = false;
      } else if (['KeyD', 'ArrowRight'].includes(e.code)) {
        keysHeld.right = false;
      } else if (['KeyX', 'KeyS', 'ArrowDown', 'KeyK'].includes(e.code)) {
        keysHeld.block = false;
      }
    });

    // One attach/clear implementation shared by the player, weapon and enemy madlib lines, rather
    // than three near-identical copies. `key` indexes into attachedImages.
    function wireImageAttach(key, ids) {
      const promptInput = document.getElementById(ids.prompt);
      const fileInput = document.getElementById(ids.file);
      const attachBtn = document.getElementById(ids.attach);
      const badge = document.getElementById(ids.badge);
      const thumb = document.getElementById(ids.thumb);
      const nameEl = document.getElementById(ids.name);
      const clearBtn = document.getElementById(ids.clear);
      if (!promptInput || !fileInput || !attachBtn) return;

      attachBtn.addEventListener('click', () => fileInput.click());

      fileInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
          const img = new Image();
          img.onload = () => {
            const maxDim = 512;
            let w = img.width, h = img.height;
            if (w > maxDim || h > maxDim) {
              if (w > h) { h = Math.round((h * maxDim) / w); w = maxDim; }
              else { w = Math.round((w * maxDim) / h); h = maxDim; }
            }
            const cv = document.createElement('canvas');
            cv.width = w; cv.height = h;
            cv.getContext('2d').drawImage(img, 0, 0, w, h);
            const dataUrl = cv.toDataURL('image/jpeg', 0.88);

            attachedImages[key] = dataUrl;
            if (key === 'player') uploadedPlayerImageDataUrl = dataUrl;
            if (thumb) thumb.src = dataUrl;
            if (nameEl) nameEl.textContent = file.name;
            if (badge) badge.classList.remove('hidden');
            promptInput.disabled = true;
            promptInput.value = "";
          };
          img.src = event.target.result;
        };
        reader.readAsDataURL(file);
      });

      if (clearBtn) {
        clearBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          fileInput.value = "";
          attachedImages[key] = null;
          if (key === 'player') uploadedPlayerImageDataUrl = null;
          if (thumb) thumb.src = "";
          if (nameEl) nameEl.textContent = "";
          if (badge) badge.classList.add('hidden');
          promptInput.disabled = false;
          promptInput.focus();
        });
      }
    }

    wireImageAttach('player', {
      prompt: 'playerPromptInput', file: 'playerFileInput', attach: 'btnAttachPlayerImage',
      badge: 'playerImageBadge', thumb: 'playerImageThumb', name: 'playerImageName',
      clear: 'btnClearPlayerImage'
    });
    wireImageAttach('weapon', {
      prompt: 'weaponPromptInput', file: 'weaponFileInput', attach: 'btnAttachWeaponImage',
      badge: 'weaponImageBadge', thumb: 'weaponImageThumb', name: 'weaponImageName',
      clear: 'btnClearWeaponImage'
    });
    wireImageAttach('enemy', {
      prompt: 'enemyPromptInput', file: 'enemyFileInput', attach: 'btnAttachEnemyImage',
      badge: 'enemyImageBadge', thumb: 'enemyImageThumb', name: 'enemyImageName',
      clear: 'btnClearEnemyImage'
    });

    function imageToTexture(img) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = TEX_SIZE;
      const c = cv.getContext('2d');
      c.imageSmoothingEnabled = false;
      c.drawImage(img, 0, 0, TEX_SIZE, TEX_SIZE);
      return c.getImageData(0, 0, TEX_SIZE, TEX_SIZE);
    }

    // onReady (optional) fires once every requested texture has actually decoded, instead of
    // the caller assuming that's already true. enterDungeon relies on this to hold the game
    // screen back until the real art is in wallTexture/ceilingTexture/floorTexture - otherwise
    // the first render3D() paints whatever was already loaded (the Windows-95 defaults, or the
    // previous dungeon's art) and the swap to the new textures a moment later reads as a flash.
    function loadAiTextures(wallUri, ceilUri, floorUri, styleName = "Windows 95", lanternUri, onReady, doorUri, switchUri, switchOnUri) {
      // Cleared unconditionally: a dungeon with no lantern art (e.g. the Windows 95 style,
      // which keeps its procedural logo gag - see get_surface_prompts) must not keep showing
      // the PREVIOUS dungeon's AI fixture. Same for the door/switch cutouts.
      aiLanternImg = null;
      aiDoorImg = null;
      aiSwitchImg = null;
      aiSwitchOnImg = null;
      const total = [wallUri, ceilUri, floorUri, lanternUri, doorUri, switchUri, switchOnUri].filter(Boolean).length;
      let loaded = 0;

      function finish() {
        if (activeMode !== 'v1_video') {
          buildLanternWallFromBase(wallTexture, styleName);
          buildExitStairsTexture(styleName, wallTexture);
          buildDoorTexture(wallTexture, styleName);
          buildOpenDoorTexture();
          buildSwitchWallTextures(wallTexture, styleName);
        }
        if (onReady) {
          onReady();
        } else {
          render3D();
          drawMinimap();
        }
      }

      function checkDone() {
        loaded++;
        if (loaded >= total) finish();
      }

      if (wallUri) {
        const imgW = new Image();
        imgW.onload = () => { wallTexture = imageToTexture(imgW); checkDone(); };
        imgW.src = wallUri;
      }
      if (ceilUri) {
        const imgC = new Image();
        imgC.onload = () => { ceilingTexture = imageToTexture(imgC); checkDone(); };
        imgC.src = ceilUri;
      }
      if (floorUri) {
        const imgF = new Image();
        imgF.onload = () => { floorTexture = imageToTexture(imgF); checkDone(); };
        imgF.src = floorUri;
      }
      if (lanternUri) {
        const imgL = new Image();
        // Kept as an Image (not converted via imageToTexture) - buildLanternWallFromBase
        // drawImage()s it directly so its alpha channel survives the composite.
        imgL.onload = () => { aiLanternImg = imgL; checkDone(); };
        imgL.src = lanternUri;
      }
      if (doorUri) {
        const imgD = new Image();
        imgD.onload = () => { aiDoorImg = imgD; checkDone(); };
        imgD.src = doorUri;
      }
      if (switchUri) {
        const imgS = new Image();
        imgS.onload = () => { aiSwitchImg = imgS; checkDone(); };
        imgS.src = switchUri;
      }
      if (switchOnUri) {
        const imgSO = new Image();
        imgSO.onload = () => { aiSwitchOnImg = imgSO; checkDone(); };
        imgSO.src = switchOnUri;
      }

      if (total === 0) finish();
    }

    // Load a finished bundle into the engine and show the game. Split out of the poll
    // loop so the transition is driven by the ENTER button instead of firing the moment
    // generation happens to finish.
    function enterDungeon(b) {
      if (!b) return;
      // Freeze the dungeon's start-of-run state now, while nothing has moved and every gate is
      // still shut, so the death screen's "Restart Dungeon" can roll back to exactly here.
      dungeonSnapshot = {
        bundle: b,
        map: MAP.map(row => row.slice()),
        passages: passagesList.map(p => ({ x: p.x, y: p.y })),
        doors: doorList.map(d => ({ ...d })),
        switches: switchList.map(s => ({ ...s })),
        enemies: enemyMarkers.map(m => ({ ...m })),
        player: { ...player }
      };
      // A brand new dungeon is a brand new hero: level 1, base bars, no banked picks.
      resetProgression();
      updateProgressionHUD();
      // Narration keeps playing across screen changes; silence it before the game starts.
      stopNarration();
      // The loading loop plays right up to this click - fade it out under the start sting.
      stopScreenMusic();
      // Fetch the win and death loops now, while the player still has a whole dungeon between
      // them and either box. Decoding a 90s buffer at the moment of death would be audible.
      loadScreenMusic('death');
      loadScreenMusic('victory');
      // The level-up loop is wanted mid-run and with no warning - the box opens the instant a
      // kill crosses a threshold - so it has to be in memory before the first fight, not
      // fetched when it is already needed.
      loadScreenMusic('levelup');
      // Belt-and-braces: playScreenMusic already retired the menu loop when the narrator
      // finished, but nothing should still be playing it once the dungeon itself starts.
      menuMusicStopped = true;
      stopMenuMusicLoop();
      // v6 ships bundle.sfx; every other mode leaves it undefined and playSfx falls back to
      // the procedural bank.
      loadSfxBank(b.sfx);
      playSfx('start', { vary: 0, gain: START_STING_GAIN });   // fixed pitch: a signature, not foley
      // v6 with sound_mode "music_and_sound" ships bundle.music; everything else leaves it
      // undefined and loadMusicBank just tears down the previous dungeon's loops.
      loadMusicBank(b.music);
      if (b.player_sprites && b.player_sprites.length > 0) {
        playerSpriteFrames = [];
        b.player_sprites.forEach(src => {
          const img = new Image();
          img.src = src;
          playerSpriteFrames.push(img);
        });
        playerSpriteImg = playerSpriteFrames[0];
      } else if (b.player_sprite) {
        playerSpriteImg = new Image();
        playerSpriteImg.src = b.player_sprite;
        playerSpriteFrames = [playerSpriteImg];
      }
      // v5 (krea2): separately generated weapon & shield sprites the rig animates
      // as overlays. Cleared first so switching back to another mode drops them.
      weaponSpriteImg = null;
      shieldSpriteImg = null;
      if (b.weapon_sprite) {
        weaponSpriteImg = new Image();
        weaponSpriteImg.src = b.weapon_sprite;
      }
      if (b.shield_sprite) {
        shieldSpriteImg = new Image();
        shieldSpriteImg.src = b.shield_sprite;
      }
      playerFaceFrames = [];
      if (b.player_faces && b.player_faces.length > 0) {
        b.player_faces.forEach(src => {
          const img = new Image();
          img.src = src;
          playerFaceFrames.push(img);
        });
        playerFaceImg = playerFaceFrames[0];
      } else if (b.player_face) {
        playerFaceImg = new Image();
        playerFaceImg.src = b.player_face;
        playerFaceFrames = [playerFaceImg];
      }
      enemySpriteFrames = [];
      enemyVariantImgs = {};
      enemyFrames = null;
      // walker / flyer / boss, each with its own {idle, attack, block?} sprites. A bundle
      // generated before the extra frames existed sends a bare data URL per variant, so
      // accept that shape too and treat it as an idle-only foe. Older modes send only
      // enemy_sprites - fold that in as the walker.
      if (b.enemy_variants) {
        Object.entries(b.enemy_variants).forEach(([key, val]) => {
          if (!val) return;
          const srcs = (typeof val === 'string') ? { idle: val } : val;
          const set = {};
          Object.entries(srcs).forEach(([frame, src]) => {
            if (!src) return;
            const img = new Image();
            img.src = src;
            set[frame] = img;
          });
          if (set.idle) enemyVariantImgs[key] = set;
        });
      }
      if (b.enemy_sprites && b.enemy_sprites.length > 0) {
        b.enemy_sprites.forEach(src => {
          const img = new Image();
          img.src = src;
          enemySpriteFrames.push(img);
        });
        if (!enemyVariantImgs.walker) enemyVariantImgs.walker = { idle: enemySpriteFrames[0] };
      }
      // Common foe name (walker/flyer) vs. the boss's own name (boss variant) - see
      // pickEnemyVariant, which is what actually assigns combatState.enemy.name.
      enemyStyleName = ((dungeonStory && dungeonStory.foe) || b.enemy_style || '').trim();
      enemyBossName = ((dungeonStory && dungeonStory.boss) || '').trim();
      enemyVariantNames = (b.enemy_names && typeof b.enemy_names === 'object') ? b.enemy_names : {};
      pickEnemyVariant();

      const showGameScreen = () => {
        screenProgress.classList.add('hidden');
        screenGame.classList.remove('hidden');
        if (titleButtons) titleButtons.classList.remove('hidden');
        appContainer.className = 'win95-box p-1 text-black mode-game';
        render3D();
        drawMinimap();
        updateHUD();
      };

      if (activeMode === 'v1_video') {
        // Video mode never raycasts these textures, so there's nothing worth blocking on.
        loadAiTextures(b.wall_texture, b.ceiling_texture, b.floor_texture, b.wall_style || currentThemeName, b.lantern_texture, null, b.door_texture, b.switch_texture, b.switch_on_texture);
        showGameScreen();
      } else {
        // Hold the game screen (and its first render3D()) until the real wall/ceiling/floor/
        // lantern art has decoded, so the player never sees a frame of stale textures before
        // the swap.
        loadAiTextures(b.wall_texture, b.ceiling_texture, b.floor_texture, b.wall_style || currentThemeName, b.lantern_texture, showGameScreen, b.door_texture, b.switch_texture, b.switch_on_texture);
      }
    }

    // ---- Intro crawl -------------------------------------------------------
    // Rendered as soon as the story lands, while every sprite is still being generated.
    // The CSS animation runs with fill-mode forwards, so if the text outruns the art it
    // simply settles on its last frame and holds while the bar keeps moving underneath.
    const CRAWL_SECONDS_PER_PARAGRAPH = 22;
    const CRAWL_MIN_SECONDS = 55;

    function startCrawl(story) {
      if (!story || crawlStarted) return;
      crawlStarted = true;
      dungeonStory = story;
      applyHeroStatusLabel();

      const paras = Array.isArray(story.crawl) ? story.crawl : [];
      const frag = document.createDocumentFragment();

      const title = document.createElement('p');
      title.className = 'crawl-title';
      title.textContent = (story.location || 'THE DUNGEON').toUpperCase();
      frag.appendChild(title);

      paras.forEach(text => {
        const p = document.createElement('p');
        p.textContent = text;   // textContent, not innerHTML: this string came from a model
        frag.appendChild(p);
      });

      // The closing send-off: one short line, visually set apart from the crawl proper.
      // Appended last so it lines up with the final clip in story.audio (server order is
      // title, each crawl paragraph, then the hook).
      if (story.hook) {
        const hook = document.createElement('p');
        hook.className = 'crawl-hook';
        hook.textContent = story.hook;
        frag.appendChild(hook);
      }

      crawlText.innerHTML = '';
      crawlText.appendChild(frag);
      if (crawlPending) crawlPending.style.display = 'none';

      const seconds = Math.max(CRAWL_MIN_SECONDS,
                               (paras.length + (story.hook ? 2 : 1)) * CRAWL_SECONDS_PER_PARAGRAPH);
      crawlText.style.setProperty('--crawl-duration', seconds + 's');
      // Restart cleanly if a previous dungeon left the animation on the node.
      crawlText.classList.remove('rolling');
      void crawlText.offsetWidth;
      crawlText.classList.add('rolling');

      startNarration();
      // A story with no audio (generation failed, or a mode that never renders any) has no
      // "when the narrator stops" moment to wait for, so the loading loop starts now.
      if (!narrationActive()) playScreenMusic('loading');
    }

    function resetCrawl() {
      // Before anything else: a second CREATE must not leave the previous dungeon's
      // narrator talking over the new one, or its loading loop running under the menu music
      // this screen opens on.
      stopNarration();
      stopScreenMusic();
      crawlStarted = false;
      if (crawlStage) crawlStage.style.display = '';
      if (progHeaderText) progHeaderText.textContent = 'Generating Dungeon Assets & Character...';
      if (progHeaderIcon) progHeaderIcon.textContent = '\u23f3';
      progSubText.style.display = '';
      pendingBundle = null;
      dungeonStory = null;
      applyHeroStatusLabel();
      if (crawlText) {
        crawlText.classList.remove('rolling');
        crawlText.innerHTML = '';
      }
      if (crawlPending) crawlPending.style.display = '';
      if (btnEnterDungeon) {
        btnEnterDungeon.disabled = true;
        btnEnterDungeon.textContent = 'GENERATING ASSETS';
      }
    }

    // Assets are ready, but the player decides when to stop reading.
    function armEnterDungeon(bundle) {
      playSfx('ready');
      pendingBundle = bundle;
      if (bundle && bundle.story) {
        dungeonStory = bundle.story;
        startCrawl(bundle.story);
      } else if (!crawlStarted) {
        // Legacy v1-v4 modes never generate a story; collapse the stage rather than leave
        // "The chronicle is being written..." sitting there after everything is done.
        if (crawlStage) crawlStage.style.display = 'none';
      }
      // Loading is done, so the loading loop scores whatever reading time the player takes
      // before pressing ENTER. Checked after startCrawl above rather than before it, because
      // on a bundle that carries its own story the narrator only arms on that line - if the
      // narrator is now running it gets to finish first and finishNarration() starts the
      // loop, so the two never overlap.
      if (!narrationActive()) playScreenMusic('loading');
      const where = (dungeonStory && dungeonStory.location) ? dungeonStory.location : '';
      btnEnterDungeon.textContent = where ? ('ENTER ' + where.toUpperCase()) : 'ENTER THE DUNGEON';
      btnEnterDungeon.disabled = false;
      btnEnterDungeon.classList.add('bg-yellow-100');

      // Nothing is generating any more, so the whole progress readout stops pretending.
      if (progHeaderText) progHeaderText.textContent = 'Generated!';
      if (progHeaderIcon) progHeaderIcon.textContent = '\u2705';
      progStatusText.textContent = 'Done.';
      progSubText.style.display = 'none';
    }

    function tryEnterDungeon() {
      if (!pendingBundle) return;
      const b = pendingBundle;
      pendingBundle = null;
      enterDungeon(b);
    }

    if (btnEnterDungeon) {
      btnEnterDungeon.addEventListener('click', tryEnterDungeon);
    }

    // On the loading screen, once assets are ready (ENTER button armed), Space or Enter
    // starts the game just like clicking the button. Gated on the progress screen being
    // up and the button being enabled, so it can't fire mid-generation or from the game.
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' && e.code !== 'Enter') return;
      if (screenProgress.classList.contains('hidden')) return;
      if (!btnEnterDungeon || btnEnterDungeon.disabled || !pendingBundle) return;
      e.preventDefault();
      tryEnterDungeon();
    });

    btnCreate.addEventListener('click', async () => {
      const wallStyle = wallPromptInput.value.trim() || "Windows 95";
      currentThemeName = wallStyle;
      activeMode = 'v6_krea';   // engine mode picker removed - v6 is the only engine now
      const numGrids = (DIFFICULTIES[selectedDifficulty] || DIFFICULTIES.medium).grids;

      // Start every dungeon from a clean slate. Quitting straight from an active battle (without
      // pressing Space to leave battle mode first) used to carry that fight's drained stamina,
      // damage and held keys into the new dungeon.
      resetCombatForNewDungeon();

      resetCrawl();
      screenSetup.classList.add('hidden');
      screenProgress.classList.remove('hidden');
      if (titleButtons) titleButtons.classList.add('hidden');
      appContainer.className = 'win95-box p-1 text-black mode-progress';

      progSubText.textContent = `Building the ${numGrids}-grid maze while ComfyUI works...`;

      generateAuthentic3DMaze(numGrids);
      buildExitStairsTexture(wallStyle, wallTexture);

      const startTime = Date.now();
      progTimer.textContent = "0.0s";
      const timerInterval = setInterval(() => {
        progTimer.textContent = ((Date.now() - startTime) / 1000).toFixed(1) + "s";
      }, 100);

      try {
        await fetch(`${SERVER_URL}/api/generate_dungeon`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            wall_style: wallStyle,
            player_style: playerPromptInput ? playerPromptInput.value.trim() : "",
            player_image: uploadedPlayerImageDataUrl || null,
            weapon_style: weaponPromptInput ? weaponPromptInput.value.trim() : "",
            weapon_image: attachedImages.weapon || null,
            enemy_style: enemyPromptInput ? enemyPromptInput.value.trim() : "",
            enemy_image: attachedImages.enemy || null,
            mode: activeMode,
            sound_mode: soundModeSelect ? soundModeSelect.value : 'music_and_sound',
            graphics_quality: gfxQualitySelect ? gfxQualitySelect.value : 'normal'
          })
        });

        const pollInterval = setInterval(async () => {
          try {
            const res = await fetch(`${SERVER_URL}/api/progress`);
            const p = await res.json();

            progStatusText.textContent = p.status_message;
            progPercentText.textContent = p.percent + "%";
            // Live sub-job detail ("slash2 - step 5/8"). This element used to be written
            // once at submit time and then never again.
            if (p.phase) progSubText.textContent = p.phase;

            // The story lands minutes ahead of the art - start reading immediately.
            if (p.story && !crawlStarted) startCrawl(p.story);

            // Classic Win98 install-bar: fixed-pitch blocks sized to the trough's actual
            // width, so the row always reaches the right edge at 100% instead of a static
            // chunk count leaving a gap (or, before the trough had a real width, a bar
            // that could never show any chunks at all).
            const chunkPitch = 12; // .win95-prog-chunk: 10px wide + 2px margin-right
            const troughWidth = progBarChunks.parentElement
              ? progBarChunks.parentElement.clientWidth
              : 0;
            const maxChunks = Math.max(1, Math.floor(troughWidth / chunkPitch));
            const chunkCount = Math.round((p.percent / 100) * maxChunks);
            progBarChunks.innerHTML = '';
            for (let i = 0; i < chunkCount; i++) {
              const ch = document.createElement('div');
              ch.className = 'win95-prog-chunk';
              progBarChunks.appendChild(ch);
            }

            if (!p.is_generating && p.completed_bundle) {
              clearInterval(pollInterval);
              clearInterval(timerInterval);
              armEnterDungeon(p.completed_bundle);
            } else if (p.error) {
              clearInterval(pollInterval);
              clearInterval(timerInterval);
              alert("Error: " + p.error);
              resetCrawl();
              screenProgress.classList.add('hidden');
              screenSetup.classList.remove('hidden');
              if (titleButtons) titleButtons.classList.remove('hidden');
              appContainer.className = 'win95-box p-1 text-black mode-setup w-full';
            }
          } catch (err) {
            console.error('Progress poll error:', err);
          }
        }, 600);

      } catch (err) {
        clearInterval(timerInterval);
        alert('Server communication error. Make sure server.py is running!');
        resetCrawl();
        screenProgress.classList.add('hidden');
        screenSetup.classList.remove('hidden');
        if (titleButtons) titleButtons.classList.remove('hidden');
        appContainer.className = 'win95-box p-1 text-black mode-setup w-full';
      }
    });

    // Boot engine
    buildDefaultTextures();
    generateAuthentic3DMaze(DIFFICULTIES.medium.grids);
    render3D();
    drawMinimap();
    updateHUD();
