    const SERVER_URL = "http://127.0.0.1:5555";

    const appContainer = document.getElementById('appContainer');
    const screenSetup = document.getElementById('screenSetup');
    const screenProgress = document.getElementById('screenProgress');
    const screenGame = document.getElementById('screenGame');
    const modalSettings = document.getElementById('modalSettings');
    const victoryModal = document.getElementById('victoryModal');
    const btnPlayAgain = document.getElementById('btnPlayAgain');
    const winMovesCount = document.getElementById('winMovesCount');

    const modeSelect = document.getElementById('modeSelect');
    const modeDesc = document.getElementById('modeDesc');
    const krea2ResInput = document.getElementById('krea2ResInput');
    const krea2StepsInput = document.getElementById('krea2StepsInput');
    const krea2PortraitResInput = document.getElementById('krea2PortraitResInput');
    const gridCountInput = document.getElementById('gridCountInput');
    const gridCountSlider = document.getElementById('gridCountSlider');
    const gridDesc = document.getElementById('gridDesc');
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
    const chkAutoEnter = document.getElementById('chkAutoEnter');
    const chkNarrate = document.getElementById('chkNarrate');
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
    let exitSignTexture = null;

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
    let enemyVariantImgs = {};
    let enemyStyleName = '';
    // The generated intro: {location, hero, foe, boss, crawl:[...]}. Arrives from
    // /api/progress minutes before the art does, and names the enemies in combat.
    let dungeonStory = null;
    // Set once generation finishes; the player enters on their own schedule, not ours.
    let pendingBundle = null;
    let crawlStarted = false;

    // Remembered across sessions: skip the ENTER button and drop straight into the
    // dungeon the moment generation finishes.
    const AUTO_ENTER_KEY = 'comfycrawler.autoEnter';
    function loadAutoEnter() {
      try { return localStorage.getItem(AUTO_ENTER_KEY) === '1'; } catch (e) { return false; }
    }
    function saveAutoEnter(on) {
      try { localStorage.setItem(AUTO_ENTER_KEY, on ? '1' : '0'); } catch (e) { /* private mode */ }
    }
    if (chkAutoEnter) {
      chkAutoEnter.checked = loadAutoEnter();
      chkAutoEnter.addEventListener('change', () => saveAutoEnter(chkAutoEnter.checked));
    }

    // ---- Intro narration (Piper, pre-rendered server-side) -----------------
    // The server picks one narrator (alan or kristin) per story and ships back one WAV
    // clip per paragraph as a data URL in bundle.story.audio, in the same order as the
    // <p> elements startCrawl() builds - title first, then each crawl paragraph. Playback
    // is just one <audio> element working through that list; no voice picking, no
    // getVoices()/voiceschanged race, no Chrome pause-queue bug - all of that lived on the
    // browser-TTS side and none of it applies to a plain audio file.
    // Defaults ON (it is the point of the feature) but is remembered once touched, hence
    // !== '0' rather than === '1'.
    const NARRATE_KEY = 'comfycrawler.narrate';
    function loadNarrate() {
      try { return localStorage.getItem(NARRATE_KEY) !== '0'; } catch (e) { return true; }
    }
    function saveNarrate(on) {
      try { localStorage.setItem(NARRATE_KEY, on ? '1' : '0'); } catch (e) { /* private mode */ }
    }

    let narrateAudio = null;       // one <audio> element, reused clip to clip
    let narrateClips = [];         // [{el: <p>, src: dataUrl}, ...] for the active story
    let narrateIndex = 0;
    let narrateStartCheck = null;

    function stopNarration() {
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

    function playNarrationClip(i) {
      narrateIndex = i;
      narrateClips.forEach((c, idx) => c.el.classList.toggle('speaking', idx === i));
      if (i >= narrateClips.length) { stopNarration(); return; }
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
      playNarrationClip(narrateIndex + 1);
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
      if (chkNarrate && !chkNarrate.checked) return;
      if (screenProgress.classList.contains('hidden')) return;
      const story = dungeonStory;
      if (!story || !Array.isArray(story.audio) || !story.audio.length) return;

      const paras = Array.from(crawlText.querySelectorAll('p'));
      const n = Math.min(paras.length, story.audio.length);
      if (!n) return;

      stopNarration();
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

    if (chkNarrate) {
      chkNarrate.checked = loadNarrate();
      chkNarrate.addEventListener('change', () => {
        saveNarrate(chkNarrate.checked);
        if (chkNarrate.checked) startNarration();
        else stopNarration();
      });
    }
    if (btnNarrateManual) {
      btnNarrateManual.addEventListener('click', () => {
        if (narrateClips.length) retryNarrationPlay();
        else startNarration();
      });
    }
    window.addEventListener('beforeunload', stopNarration);
    // HUD portrait expressions, in PORTRAIT_FRAME_NAMES order: idle, attack, block, hurt.
    let playerFaceFrames = [];
    let rig = { swordX: 24, swordY: -30, shieldX: -28, shieldY: -32 };

    let MAP = [];
    let MAP_WIDTH = 0;
    let MAP_HEIGHT = 0;
    let visitedTiles = new Set();
    let passagesList = [];
    let lanternList = [];
    let exitRoom = { x: 5, y: 5 };
    let startRoom = { x: 1, y: 1 };
    let zBuffer = new Float64Array(screenWidth);

    let activeMode = 'v6_krea';
    let currentThemeName = "Windows 95";
    let totalMoves = 0;
    let queuedAction = null;

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
      screenSetup.classList.remove('hidden');
      if (titleButtons) titleButtons.classList.remove('hidden');
      appContainer.className = 'win95-box p-1 text-black mode-setup w-full';
    }

    btnClose.addEventListener('click', () => {
      if (!screenGame.classList.contains('hidden')) {
        if (confirm("Would you like to create a new dungeon?")) openSetupScreen();
      } else {
        openSetupScreen();
      }
    });

    btnPlayAgain.addEventListener('click', openSetupScreen);

    function updateGridText(val) {
      const v = Math.max(10, Math.min(100, parseInt(val) || 25));
      gridCountInput.value = v;
      gridCountSlider.value = v;
      if (v <= 15) gridDesc.textContent = `Quick 3DMaze: ${v} grid corridors with glowing lanterns and Exit.`;
      else if (v <= 35) gridDesc.textContent = `Standard 3DMaze Labyrinth: ${v} corridors with branching paths and lanterns.`;
      else if (v <= 70) gridDesc.textContent = `Large 3DMaze Labyrinth: ${v} complex winding passages with distant Exit.`;
      else gridDesc.textContent = `Epic 3DMaze Challenge: ${v} massive interconnected passages!`;
    }

    gridCountInput.addEventListener('input', (e) => updateGridText(e.target.value));
    gridCountSlider.addEventListener('input', (e) => updateGridText(e.target.value));

    btnSettings.addEventListener('click', () => modalSettings.classList.remove('hidden'));
    btnCloseSettings.addEventListener('click', () => modalSettings.classList.add('hidden'));
    btnSaveSettings.addEventListener('click', () => modalSettings.classList.add('hidden'));

    const MODE_DESCRIPTIONS = {
      v6_krea: '<strong>v6 krea2 turbo:</strong> like v5, but the player is a 7-frame krea2 swing animation (shared seed) swapped through on block / attack / hurt, the way v4 did it.',
      v5_krea: '<strong>v5 krea2 turbo:</strong> FLUX schnell tiles the dungeon; krea2 turbo makes the player, weapon, shield, enemy & portrait in one clean pass each.',
      v4_flux: '<strong>v4 Multi-Frame Sprite Engine:</strong> SDXL-Lightning + IPAdapter + OpenPose rig, 5 posed player frames with composited gear.',
      v3_flux: '<strong>v3 FLUX.1 [schnell]:</strong> Synthesizes full 3D environment & custom warrior character in ~10s.',
      v2_texture: '<strong>v2 texture:</strong> MiniMax H3 material textures in a 3D raycaster.',
      v1_video: '<strong>v1 video:</strong> Pre-rendered frame-chained FMV clips.',
    };
    const krea2Settings = document.getElementById('krea2Settings');
    const KREA2_MODES = ['v5_krea', 'v6_krea'];
    const syncModeDesc = () => {
      if (modeDesc && MODE_DESCRIPTIONS[modeSelect.value]) modeDesc.innerHTML = MODE_DESCRIPTIONS[modeSelect.value];
      if (krea2Settings) krea2Settings.classList.toggle('hidden', !KREA2_MODES.includes(modeSelect.value));
    };
    modeSelect.addEventListener('change', syncModeDesc);
    syncModeDesc();

    // Each quick idea fills in the whole setup - dungeon look plus the player, weapon and
    // enemy - so one click gives a coherent theme instead of just a wall style. Fields that
    // are locked to an uploaded image are left alone.
    const PRESET_IDEAS = {
      'Windows 95 3D maze': { player: 'guy in a shirt and tie with thick glasses', weapon: 'computer keyboard',     enemy: 'stick of ram' },
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
    const btnToggleBattle = document.getElementById('btnToggleBattle');
    const battleActionBar = document.getElementById('battleActionBar');
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
    const controlsHeader = document.getElementById('controlsHeader');

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
        blockTimer: 0    // walker: >0 = guarding, the next player strike is largely absorbed
      },
      faceState: 'idle',
      faceTimer: 0,
      glanceDir: 0,
      glanceTimer: 60
    };

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
    const ENEMY_VARIANTS = {
      walker: { tag: '',       maxHp: 100, dmg: 16, cadence: 115, telegraph: 30, heightFrac: 0.44, widthFrac: 0.52, fly: false, canBlock: true,  slow: false, hover: 0  },
      flyer:  { tag: 'FLYING ', maxHp: 70,  dmg: 13, cadence: 95,  telegraph: 20, heightFrac: 0.40, widthFrac: 0.66, fly: true,  canBlock: false, slow: false, hover: 58 },
      boss:   { tag: 'DREAD ',  maxHp: 240, dmg: 30, cadence: 160, telegraph: 46, heightFrac: 0.68, widthFrac: 0.78, fly: false, canBlock: false, slow: true,  hover: 0  },
    };
    const ENEMY_VARIANT_KEYS = ['walker', 'flyer', 'boss'];

    // Roll one of the three foes and apply its stats. Called on every battle entry, so during
    // testing you cycle the variants just by leaving and re-entering combat (Space).
    function pickEnemyVariant(forceKey) {
      // Only roll the full set when we actually have distinct sprites for it (v5/v6 krea);
      // other modes ship one enemy, so they stay on the walker.
      const haveVariants = ENEMY_VARIANT_KEYS.filter(k => enemyVariantImgs[k]).length >= 2;
      const key = forceKey || (haveVariants
        ? ENEMY_VARIANT_KEYS[Math.floor(Math.random() * ENEMY_VARIANT_KEYS.length)]
        : 'walker');
      const cfg = ENEMY_VARIANTS[key] || ENEMY_VARIANTS.walker;
      const e = combatState.enemy;
      e.variant = key;
      e.maxHp = cfg.maxHp;
      e.hp = cfg.maxHp;
      e.state = 'idle';
      e.stateTimer = 0;
      e.attackTimer = cfg.cadence;
      e.x = 0;
      e.vx = cfg.slow ? 0.5 : 1.5;
      e.altitude = cfg.hover;
      e.swoop = 'none';
      e.swoopTimer = cfg.fly ? 90 : 0;
      e.blockTimer = 0;
      // Every foe is named after the story's champion, with the variant tag in front:
      // "GOLEM OF DATA", "FLYING GOLEM OF DATA", "DREAD GOLEM OF DATA".
      e.name = (cfg.tag + (enemyStyleName || 'nightstalker')).toUpperCase();
      // Only swap the active sprite when we have a real per-variant set; otherwise leave
      // whatever the bundle loaded (e.g. v3/v4's 3-frame idle/attack/hurt enemy).
      const img = enemyVariantImgs[key];
      if (img && haveVariants) enemySpriteFrames = [img];
      return key;
    }

    function toggleBattleMode(forceState) {
      if (typeof forceState === 'boolean') {
        combatState.inBattle = forceState;
      } else {
        combatState.inBattle = !combatState.inBattle;
      }

      if (combatState.inBattle) {
        if (battleModeBadge) {
          battleModeBadge.textContent = "BATTLE TIME";
          battleModeBadge.className = "text-[9px] font-bold px-1.5 py-0.2 rounded bg-red-600 text-white animate-pulse";
        }
        if (battleActionBar) battleActionBar.classList.remove('hidden');
        if (controlsHeader) controlsHeader.textContent = "COMBAT: A/D (Strafe), Z (Strike), X (Block)";
        if (btnToggleBattle) {
          btnToggleBattle.innerHTML = "🏃 <span>FLEE (Space)</span>";
          btnToggleBattle.className = "win95-btn px-2 py-0.5 text-[10px] font-bold text-slate-800 bg-slate-200 hover:bg-slate-300";
        }

        combatState.playerX = 0;
        combatState.vx = 0;
        combatState.attackFrame = 0;
        combatState.hurtFrame = 0;
        combatState.shieldProgress = 0;

        // Roll a fresh foe (walker / flyer / boss) every time a battle begins.
        pickEnemyVariant();

        showFloatingCombatText(`${combatState.enemy.name} APPROACHES!`, 160, 80, "#facc15");
      } else {
        if (battleModeBadge) {
          battleModeBadge.textContent = "MAZE EXPLORATION";
          battleModeBadge.className = "text-[9px] font-bold px-1.5 py-0.2 rounded bg-slate-300 text-slate-800";
        }
        if (battleActionBar) battleActionBar.classList.add('hidden');
        if (controlsHeader) controlsHeader.textContent = "CONTROLS (Space: Battle):";
        if (btnToggleBattle) {
          btnToggleBattle.innerHTML = "⚔️ <span>BATTLE (Space)</span>";
          btnToggleBattle.className = "win95-btn px-2 py-0.5 text-[10px] font-bold text-red-900 bg-red-100 hover:bg-red-200";
        }
        // Hiding the action bar mid-press means the Block button never receives its pointerup or
        // pointerleave, so keysHeld.block would stay stuck on - and a stuck block drains stamina to
        // 2 and then blocks its own regen forever (see the regen guard in the combat loop).
        releaseHeldKeys();
      }
      render3D();
    }

    // Any held input has to be dropped whenever the player stops actively driving the game, or a
    // key that never got its keyup survives into the next dungeon.
    function releaseHeldKeys() {
      keysHeld.left = false;
      keysHeld.right = false;
      keysHeld.block = false;
    }

    // Full combat reset for a brand new dungeon. Without this, stamina (and HP, and any in-flight
    // attack/hurt frames) carried over from the previous dungeon - so a run started while blocking
    // or mid-fight began the next dungeon at near-zero stamina.
    function resetCombatForNewDungeon() {
      // Go through toggleBattleMode rather than just clearing the flag, so the badge, action bar,
      // controls header and Battle/Flee button all return to exploration state too - otherwise the
      // new dungeon starts out of battle but still wearing the "BATTLE TIME" chrome.
      if (combatState.inBattle) toggleBattleMode(false);
      releaseHeldKeys();
      combatState.playerStm = combatState.playerMaxStm;
      combatState.playerHp = combatState.playerMaxHp;
      combatState.playerX = 0;
      combatState.vx = 0;
      combatState.attackFrame = 0;
      combatState.hurtFrame = 0;
      combatState.shieldProgress = 0;
      combatState.combatEffects.length = 0;
      pickEnemyVariant();
    }

    // Alt-tabbing or clicking into a text field while holding X swallows the keyup the same way.
    window.addEventListener('blur', releaseHeldKeys);

    if (btnToggleBattle) {
      btnToggleBattle.addEventListener('click', () => toggleBattleMode());
    }

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
      if (!combatState.inBattle || combatState.attackFrame > 0 || combatState.hurtFrame > 0) return;
      if (combatState.playerStm < 15) {
        showFloatingCombatText("NO STAMINA!", 160, 180, "#ef4444");
        return;
      }
      combatState.playerStm = Math.max(0, combatState.playerStm - 15);
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

    // 60 FPS Combat Game Loop
    setInterval(() => {
      if (!screenGame || screenGame.classList.contains('hidden')) return;

      if (combatState.inBattle) {
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
          combatState.playerStm = Math.max(0, combatState.playerStm - 0.12);
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
        if (combatState.attackFrame === 7 && combatState.enemy.hp > 0) {
          const e = combatState.enemy;
          const cfg = ENEMY_VARIANTS[e.variant] || ENEMY_VARIANTS.walker;
          const outOfReach = cfg.fly && e.altitude > 34;
          const guarded = e.blockTimer > 0;
          if (outOfReach) {
            showFloatingCombatText("OUT OF REACH!", 160, 90, "#93c5fd");
          } else {
            let dmg = 24 + Math.floor(Math.random() * 12);
            if (guarded) { dmg = Math.max(1, Math.floor(dmg * 0.25)); e.blockTimer = 0; }
            if (cfg.slow) dmg = Math.floor(dmg * 0.7);   // boss is armoured
            e.hp = Math.max(0, e.hp - dmg);
            e.state = 'hurt';
            e.stateTimer = 12;
            showFloatingCombatText(guarded ? `BLOCKED! -${dmg}` : `-${dmg} SLASH!`,
              160 + (Math.random() * 30 - 15), 100, guarded ? "#94a3b8" : "#f87171");

            if (e.hp <= 0) {
              e.state = 'defeated';
              showFloatingCombatText("VICTORY! +50 ESSENCE", 160, 70, "#fde047");
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

      if (combatState.inBattle && combatState.enemy.hp > 0) {
        const e = combatState.enemy;
        const cfg = ENEMY_VARIANTS[e.variant] || ENEMY_VARIANTS.walker;
        if (e.blockTimer > 0) e.blockTimer--;

        // Resolve one of the enemy's telegraphed strikes against the player's position/guard.
        const landStrike = (dmg, dodgeMsg, blockMsg, hitLabel) => {
          const isDodged = Math.abs(combatState.playerX - e.x) > 44;
          const isGuarded = combatState.shieldProgress > 0.6;
          if (isDodged) {
            showFloatingCombatText(dodgeMsg, 160, 130, "#38bdf8");
          } else if (isGuarded) {
            showFloatingCombatText(blockMsg, 160, 140, "#a855f7");
            combatState.playerHp = Math.max(1, combatState.playerHp - Math.round(dmg * 0.12));
          } else {
            combatState.playerHp = Math.max(0, combatState.playerHp - dmg);
            combatState.hurtFrame = 1;
            combatState.faceState = 'hurt';
            combatState.faceTimer = 26;
            showFloatingCombatText(`-${dmg} ${hitLabel}`, 160, 160, "#dc2626");
          }
        };

        if (cfg.fly) {
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
              landStrike(cfg.dmg, "DODGED THE SWOOP!", "🛡️ SWOOP BLOCKED!", "SWOOP!");
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
          // Walker & boss: strafe along the ground. The boss barely moves and hits like a truck.
          const range = cfg.slow ? 24 : 58;
          const spd = cfg.slow ? 0.5 : 1.5;
          if (e.state !== 'attack' && e.state !== 'telegraph') {
            e.x += e.vx;
            if (e.x > range) { e.x = range; e.vx = -spd; }
            else if (e.x < -range) { e.x = -range; e.vx = spd; }
          }

          if (e.state === 'hurt' || e.state === 'attack') {
            e.stateTimer--;
            if (e.stateTimer <= 0) e.state = 'idle';
          } else {
            e.attackTimer--;
            // A walker occasionally raises its guard between attacks (see the player-strike
            // resolution, where e.blockTimer soaks most of a hit).
            if (cfg.canBlock && e.state === 'idle' && e.blockTimer <= 0 && Math.random() < 0.006) {
              e.blockTimer = 75;
              showFloatingCombatText("ENEMY GUARDS", 160 + e.x, 78, "#94a3b8");
            }
            if (e.attackTimer === cfg.telegraph) {
              e.state = 'telegraph';
              showFloatingCombatText(cfg.slow ? "⚠️ HEAVY WIND-UP!" : "⚠️ ENEMY WIND-UP!", 160, 75, "#fbbf24");
            } else if (e.attackTimer <= 0) {
              e.attackTimer = cfg.cadence + Math.floor(Math.random() * 50);
              e.state = 'attack';
              e.stateTimer = cfg.slow ? 20 : 14;
              e.blockTimer = 0;
              landStrike(cfg.dmg, "DODGED! (MISS)", "🛡️ PARRY BLOCKED!", cfg.slow ? "CRUSH!" : "HP HIT!");
            }
          }
        }
      }

      if (playerHpBar) playerHpBar.style.width = `${(combatState.playerHp / combatState.playerMaxHp) * 100}%`;
      if (playerHpText) playerHpText.textContent = `${Math.ceil(combatState.playerHp)}/${combatState.playerMaxHp}`;
      if (playerStmBar) playerStmBar.style.width = `${(combatState.playerStm / combatState.playerMaxStm) * 100}%`;
      if (playerStmText) playerStmText.textContent = `${Math.ceil(combatState.playerStm)}/${combatState.playerMaxStm}`;

      renderDoomFace();
      if (activeMode !== 'v1_video' && !player.isAnimating) {
        render3D();
      }
    }, 1000 / 60);

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
    function drawEnemyContent(c, img, cx, bottomY, targetH, maxW) {
      const aspect = img.naturalWidth / img.naturalHeight;
      const box = solidContentBox(img);
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
      const py = height + walkBob;

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

      // --- MULTI-FRAME AI SPRITE SHEET MODE (v4: 5 frames / v6: 7-frame swing) ---
      if (playerSpriteFrames && playerSpriteFrames.length > 1) {
        const v6Frames = playerSpriteFrames.length >= 7;
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
        }

        if (currentFrame && currentFrame.complete && currentFrame.naturalWidth > 0) {
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

    // High-Detail Shaded Dark Fantasy Demon Knight Enemy
    function drawCombatEnemy(c, width, height) {
      if (!combatState.inBattle || combatState.enemy.hp <= 0) return;

      const e = combatState.enemy;
      const cfg = ENEMY_VARIANTS[e.variant] || ENEMY_VARIANTS.walker;
      const GROUND_Y = 165;                       // where a grounded enemy's feet sit
      const ex = width / 2 + (e.x || 0);
      const ey = (GROUND_Y - 70) - (e.altitude || 0) + Math.sin(Date.now() / 200) * 4;

      if (e.state === 'telegraph') {
        c.fillStyle = 'rgba(239, 68, 68, 0.4)';
        c.beginPath(); c.arc(ex, ey, 60, 0, Math.PI * 2); c.fill();
      }

      // --- AI ENEMY SPRITE (idle / attack / hurt) ---
      // Falls through to the procedural enemy below when no sprites were generated, so an enemy
      // that failed to generate (or a dungeon made before this existed) still has an opponent.
      if (enemySpriteFrames && enemySpriteFrames.length > 0) {
        let frame = enemySpriteFrames[0];
        if (e.state === 'hurt') frame = enemySpriteFrames[2] || frame;
        else if (e.state === 'attack' || e.state === 'telegraph') frame = enemySpriteFrames[1] || frame;

        if (frame && frame.complete && frame.naturalWidth > 0) {
          // Size by MEASURED solid content, not the raw frame - a small generation still fills
          // the combat view. heightFrac is per-variant: boss looms, flyer is smaller & airborne.
          const targetH = Math.round(height * cfg.heightFrac);
          const maxW = Math.round(width * (cfg.widthFrac || 0.7));
          const bob = cfg.fly ? Math.sin(Date.now() / 110) * 4 : Math.sin(Date.now() / 220) * 3;
          const bottomY = GROUND_Y - (e.altitude || 0) + bob;

          c.save();
          // Ground shadow - fades and shrinks as a flyer climbs.
          const sh = cfg.fly ? Math.max(0.14, 1 - (e.altitude || 0) / 90) : 1;
          c.fillStyle = `rgba(0,0,0,${0.28 * sh})`;
          c.beginPath();
          c.ellipse(width / 2 + (e.x || 0), GROUND_Y + 3, targetH * 0.32 * sh, targetH * 0.08 * sh, 0, 0, Math.PI * 2);
          c.fill();

          if (e.state === 'hurt') { c.translate((Math.random() * 8 - 4), 0); c.globalAlpha = 0.9; }
          else if (e.blockTimer > 0) { c.globalAlpha = 0.94; }

          drawEnemyContent(c, frame, ex, bottomY, targetH, maxW);
          c.globalAlpha = 1;

          // Walker guard flash.
          if (e.blockTimer > 0) {
            c.strokeStyle = 'rgba(148,163,184,0.9)'; c.lineWidth = 3;
            c.beginPath(); c.arc(ex, bottomY - targetH * 0.5, targetH * 0.34, -0.4, Math.PI + 0.4); c.stroke();
          }
          // Boss aura.
          if (cfg.slow) {
            c.strokeStyle = 'rgba(220,38,38,0.35)'; c.lineWidth = 2;
            c.beginPath(); c.ellipse(ex, bottomY - targetH * 0.5, targetH * 0.42, targetH * 0.56, 0, 0, Math.PI * 2); c.stroke();
          }
          c.restore();
          drawEnemyHpBar(c, width, e);
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

      drawEnemyHpBar(c, width, e);
    }

    // Pulled out of drawCombatEnemy so the AI-sprite path can draw it too - that path returns
    // early to skip the procedural body, which silently took the name plate with it.
    function drawEnemyHpBar(c, width, e) {
      c.fillStyle = 'rgba(15, 23, 42, 0.9)';
      c.fillRect(width / 2 - 75, 8, 150, 18);
      c.strokeStyle = '#94a3b8'; c.lineWidth = 1.5;
      c.strokeRect(width / 2 - 75, 8, 150, 18);

      const hpW = Math.max(0, (e.hp / e.maxHp) * 146);
      c.fillStyle = '#dc2626';
      c.fillRect(width / 2 - 73, 10, hpW, 14);

      c.fillStyle = '#f8fafc';
      c.font = 'bold 10px sans-serif';
      c.textAlign = 'center';
      c.fillText(`${e.name || 'NIGHTSTALKER'} [${e.hp}/${e.maxHp}]`, width / 2, 21);
    }

    function drawCombatEffects(c) {
      for (let i = combatState.combatEffects.length - 1; i >= 0; i--) {
        const eff = combatState.combatEffects[i];
        eff.life--;
        eff.y -= 0.8;

        c.fillStyle = eff.color;
        c.font = 'bold 12px monospace';
        c.textAlign = 'center';
        c.shadowColor = '#000000';
        c.shadowBlur = 4;
        c.fillText(eff.text, eff.x, eff.y);
        c.shadowBlur = 0;

        if (eff.life <= 0) {
          combatState.combatEffects.splice(i, 1);
        }
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
      buildDynamicExitSignTexture("Windows 95", wallTexture);
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

      if (isWin95) {
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

    function buildDynamicExitSignTexture(styleName = "Windows 95", sourceWallImageData = null) {
      const cv = document.createElement('canvas');
      cv.width = 256;
      cv.height = 140;
      const c = cv.getContext('2d');
      c.imageSmoothingEnabled = false;

      c.fillStyle = 'rgba(241, 245, 249, 0.95)';
      c.fillRect(6, 6, 244, 128);

      c.strokeStyle = '#475569'; c.lineWidth = 4;
      c.strokeRect(6, 6, 244, 128);

      c.fillStyle = '#0f172a';
      c.font = '900 46px "Courier New", monospace';
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      c.fillText("End", 120, 70);

      c.fillStyle = '#eab308';
      c.beginPath(); c.arc(68, 70, 24, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#ca8a04'; c.lineWidth = 3; c.stroke();

      exitSignTexture = c.getImageData(0, 0, 256, 140);
    }

        // ==========================================
    // AUTHENTIC 3DMAZE GENERATOR (GOLDEN STANDARD - EXACT TILES)
    // ==========================================
    function generateAuthentic3DMaze(numGrids = 25) {
      numGrids = Math.max(10, Math.min(100, numGrids));

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
        const current = stack[stack.length - 1];
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
          stack.pop();
        }
      }

      // Add Lanterns to Walls
      for (let y = 1; y < MAP_HEIGHT - 1; y++) {
        for (let x = 1; x < MAP_WIDTH - 1; x++) {
          if (MAP[y][x] === 1) {
            const hasAdjacentFloor = (MAP[y-1][x] === 0 || MAP[y+1][x] === 0 || MAP[y][x-1] === 0 || MAP[y][x+1] === 0);
            if (hasAdjacentFloor && (x + y) % 3 === 0) {
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

      startRoom = { x: startC * 2 + 1, y: startR * 2 + 1 };
      exitRoom = { x: furthestCell.c * 2 + 1, y: furthestCell.r * 2 + 1 };

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
          if (MAP[mapY][mapX] > 0) hit = MAP[mapY][mapX];
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

        const wallTexToUse = (hit === 2 && wallLanternTexture) ? wallLanternTexture : wallTexture;
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

      // 3D Billboard "END" Sign
      if (exitSignTexture) {
        const spriteX = (exitRoom.x + 0.5) - posX;
        const spriteY = (exitRoom.y + 0.5) - posY;

        const invDet = 1.0 / (planeX * dirY - dirX * planeY);
        const transformX = invDet * (dirY * spriteX - dirX * spriteY);
        const transformY = invDet * (-planeY * spriteX + planeX * spriteY);

        if (transformY > 0.1) {
          const spriteScreenX = Math.floor((screenWidth / 2) * (1 + transformX / transformY));
          // 0.55 of a wall's height - scaled by WALL_HEIGHT so the sign keeps that ratio.
          const spriteHeight = Math.abs(Math.floor((screenHeight * WALL_HEIGHT / transformY) * 1.1));
          const spriteWidth = Math.floor(spriteHeight * 1.5);

          const drawStartY = Math.max(0, Math.floor(-spriteHeight / 2 + screenHeight / 2));
          const drawEndY = Math.min(screenHeight - 1, Math.floor(spriteHeight / 2 + screenHeight / 2));
          const drawStartX = Math.max(0, Math.floor(-spriteWidth / 2 + spriteScreenX));
          const drawEndX = Math.min(screenWidth - 1, Math.floor(spriteWidth / 2 + spriteScreenX));

          const signData = exitSignTexture.data;
          const signW = 256;
          const signH = 140;

          for (let stripe = drawStartX; stripe < drawEndX; stripe++) {
            const texX = Math.floor(((stripe - (-spriteWidth / 2 + spriteScreenX)) * signW) / spriteWidth);

            if (transformY > 0 && stripe >= 0 && stripe < screenWidth && transformY < zBuffer[stripe]) {
              for (let y = drawStartY; y < drawEndY; y++) {
                const d = (y - (-spriteHeight / 2 + screenHeight / 2)) * signH;
                const texY = Math.floor(d / spriteHeight);

                if (texX >= 0 && texX < signW && texY >= 0 && texY < signH) {
                  const sIdx = (texY * signW + texX) * 4;
                  const alpha = signData[sIdx + 3] / 255;

                  if (alpha > 0.05) {
                    const pIdx = (y * screenWidth + stripe) * 4;
                    buffer[pIdx] = Math.floor(buffer[pIdx] * (1 - alpha) + signData[sIdx] * alpha);
                    buffer[pIdx + 1] = Math.floor(buffer[pIdx + 1] * (1 - alpha) + signData[sIdx + 1] * alpha);
                    buffer[pIdx + 2] = Math.floor(buffer[pIdx + 2] * (1 - alpha) + signData[sIdx + 2] * alpha);
                  }
                }
              }
            }
          }
        }
      }

      ctx.putImageData(imgData, 0, 0);

      // Render 3D Combat Entities
      drawCombatEnemy(ctx, screenWidth, screenHeight);
      drawOverTheShoulderPlayer(ctx, screenWidth, screenHeight);
      drawCombatEffects(ctx);
    }

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
          if (w.x >= 0 && w.x < MAP_WIDTH && w.y >= 0 && w.y < MAP_HEIGHT && MAP[w.y][w.x] >= 1) {
            const wx = offsetX + w.x * tileSize;
            const wy = offsetY + w.y * tileSize;
            c.fillStyle = '#334155';
            c.fillRect(wx, wy, tileSize, tileSize);
            c.strokeStyle = '#475569';
            c.lineWidth = 0.5;
            c.strokeRect(wx, wy, tileSize, tileSize);
          }
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
        victoryModal.classList.remove('hidden');
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

    function moveForward() {
      if (player.isAnimating) { queuedAction = 'UP'; return; }
      const vec = DIR_VECS[player.dirIndex];
      const nextX = player.gridX + vec.dx;
      const nextY = player.gridY + vec.dy;

      // STRICT COLLISION: ONLY MAP === 0 is walkable floor! (MAP === 1 and MAP === 2 are solid walls)
      if (MAP[nextY] && MAP[nextY][nextX] === 0) {
        player.gridX = nextX;
        player.gridY = nextY;
        totalMoves++;
        animate3D(nextX + 0.5, nextY + 0.5, player.angle);
      } else {
        animateBump(vec.dx, vec.dy);
      }
    }

    function moveBackward() {
      if (player.isAnimating) { queuedAction = 'DOWN'; return; }
      const vec = DIR_VECS[player.dirIndex];
      const nextX = player.gridX - vec.dx;
      const nextY = player.gridY - vec.dy;

      // STRICT COLLISION: ONLY MAP === 0 is walkable floor!
      if (MAP[nextY] && MAP[nextY][nextX] === 0) {
        player.gridX = nextX;
        player.gridY = nextY;
        totalMoves++;
        animate3D(nextX + 0.5, nextY + 0.5, player.angle);
      } else {
        animateBump(-vec.dx, -vec.dy);
      }
    }

    function rotateLeft() {
      if (player.isAnimating) { queuedAction = 'LEFT'; return; }
      player.dirIndex = (player.dirIndex + 3) % 4;
      animate3D(player.posX, player.posY, player.angle - Math.PI / 2);
    }

    function rotateRight() {
      if (player.isAnimating) { queuedAction = 'RIGHT'; return; }
      player.dirIndex = (player.dirIndex + 1) % 4;
      animate3D(player.posX, player.posY, player.angle + Math.PI / 2);
    }

    // ==========================================
    // EVENT LISTENERS & INITIALIZATION
    // ==========================================
    btnUp.addEventListener('pointerdown', (e) => { e.preventDefault(); moveForward(); });
    btnDown.addEventListener('pointerdown', (e) => { e.preventDefault(); moveBackward(); });
    btnLeft.addEventListener('pointerdown', (e) => { e.preventDefault(); rotateLeft(); });
    btnRight.addEventListener('pointerdown', (e) => { e.preventDefault(); rotateRight(); });

    window.addEventListener('keydown', (e) => {
      if (screenGame.classList.contains('hidden')) return;

      if (e.code === 'Space') {
        e.preventDefault();
        toggleBattleMode();
        return;
      }

      if (combatState.inBattle) {
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
    function loadAiTextures(wallUri, ceilUri, floorUri, styleName = "Windows 95", onReady) {
      const total = [wallUri, ceilUri, floorUri].filter(Boolean).length;
      let loaded = 0;

      function finish() {
        if (activeMode !== 'v1_video') {
          buildLanternWallFromBase(wallTexture, styleName);
          buildDynamicExitSignTexture(styleName, wallTexture);
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

      if (total === 0) finish();
    }

    // Load a finished bundle into the engine and show the game. Split out of the poll
    // loop so the transition is driven by the ENTER button instead of firing the moment
    // generation happens to finish.
    function enterDungeon(b) {
      if (!b) return;
      // Narration keeps playing across screen changes; silence it before the game starts.
      stopNarration();
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
      // walker / flyer / boss, each its own generated sprite. Older bundles / other
      // modes only send enemy_sprites - fold that in as the walker.
      if (b.enemy_variants) {
        Object.entries(b.enemy_variants).forEach(([key, src]) => {
          if (!src) return;
          const img = new Image();
          img.src = src;
          enemyVariantImgs[key] = img;
        });
      }
      if (b.enemy_sprites && b.enemy_sprites.length > 0) {
        b.enemy_sprites.forEach(src => {
          const img = new Image();
          img.src = src;
          enemySpriteFrames.push(img);
        });
        if (!enemyVariantImgs.walker) enemyVariantImgs.walker = enemySpriteFrames[0];
      }
      // The story's boss is the name every enemy is referred to by, in preference to the
      // common-foe name or the raw phrase the player typed.
      enemyStyleName = ((dungeonStory && (dungeonStory.boss || dungeonStory.foe))
                        || b.enemy_style || '').trim();
      if (enemyStyleName) {
        combatState.enemy.name = enemyStyleName.toUpperCase();
      }
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
        loadAiTextures(b.wall_texture, b.ceiling_texture, b.floor_texture, b.wall_style || currentThemeName);
        showGameScreen();
      } else {
        // Hold the game screen (and its first render3D()) until the real wall/ceiling/floor
        // art has decoded, so the player never sees a frame of stale textures before the swap.
        loadAiTextures(b.wall_texture, b.ceiling_texture, b.floor_texture, b.wall_style || currentThemeName, showGameScreen);
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

      crawlText.innerHTML = '';
      crawlText.appendChild(frag);
      if (crawlPending) crawlPending.style.display = 'none';

      const seconds = Math.max(CRAWL_MIN_SECONDS,
                               (paras.length + 1) * CRAWL_SECONDS_PER_PARAGRAPH);
      crawlText.style.setProperty('--crawl-duration', seconds + 's');
      // Restart cleanly if a previous dungeon left the animation on the node.
      crawlText.classList.remove('rolling');
      void crawlText.offsetWidth;
      crawlText.classList.add('rolling');

      startNarration();
    }

    function resetCrawl() {
      // Before anything else: a second CREATE must not leave the previous dungeon's
      // narrator talking over the new one.
      stopNarration();
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
      pendingBundle = bundle;
      if (bundle && bundle.story) {
        dungeonStory = bundle.story;
        startCrawl(bundle.story);
      } else if (!crawlStarted) {
        // Legacy v1-v4 modes never generate a story; collapse the stage rather than leave
        // "The chronicle is being written..." sitting there after everything is done.
        if (crawlStage) crawlStage.style.display = 'none';
      }
      const where = (dungeonStory && dungeonStory.location) ? dungeonStory.location : '';
      btnEnterDungeon.textContent = where ? ('ENTER ' + where.toUpperCase()) : 'ENTER THE DUNGEON';
      btnEnterDungeon.disabled = false;
      btnEnterDungeon.classList.add('bg-yellow-100');

      // Nothing is generating any more, so the whole progress readout stops pretending.
      if (progHeaderText) progHeaderText.textContent = 'Generated!';
      if (progHeaderIcon) progHeaderIcon.textContent = '\u2705';
      progStatusText.textContent = 'Done.';
      progSubText.style.display = 'none';

      if (chkAutoEnter && chkAutoEnter.checked) {
        const b = pendingBundle;
        pendingBundle = null;
        enterDungeon(b);
      }
    }

    if (btnEnterDungeon) {
      btnEnterDungeon.addEventListener('click', () => {
        if (!pendingBundle) return;
        const b = pendingBundle;
        pendingBundle = null;
        enterDungeon(b);
      });
    }

    btnCreate.addEventListener('click', async () => {
      const wallStyle = wallPromptInput.value.trim() || "Windows 95";
      currentThemeName = wallStyle;
      activeMode = modeSelect.value;
      const numGrids = Math.max(10, Math.min(100, parseInt(gridCountInput.value) || 25));

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
      buildDynamicExitSignTexture(wallStyle, wallTexture);

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
            krea_res: krea2ResInput ? parseInt(krea2ResInput.value) || 512 : 512,
            krea_steps: krea2StepsInput ? parseInt(krea2StepsInput.value) || 8 : 8,
            krea_portrait_res: krea2PortraitResInput ? parseInt(krea2PortraitResInput.value) || 128 : 128
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
    generateAuthentic3DMaze(25);
    render3D();
    drawMinimap();
    updateHUD();
