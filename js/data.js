/* Rebuild 100 — program data
   Profile: 181 cm, 21 y, 76.7 kg start, goal 82–85 kg lean.
   Priorities: upper chest (puffy chest history), biceps, body-fat reduction. */

window.R100 = window.R100 || {};

R100.DEFAULT_SETTINGS = {
  startDate: '2026-10-13',
  heightCm: 181,
  age: 21,
  sex: 'm',
  startWeightKg: 76.7,
  goalKg: 83,
  activity: 1.5,          // 4–5 lifting days + 8–10k steps
  splitOverride: null,    // null = follow the 100-day plan
  wakeTime: '05:00',      // training is ~1 h after waking; the morning timeline builds from this
  walkToGymMin: 12,       // ~1,500 steps each way
};

/* ---------- Exercise library ---------- */
R100.EXERCISES = {
  inc_db_press:    { name: 'Incline dumbbell press (30°)', m: 'Upper chest, front delt, triceps', cue: 'Bench at 30°, not 45°. Shoulder blades pinned back and down. Lower to nipple line, elbows ~45°. Full stretch at the bottom, do not bounce.', sub: ['Incline machine press', 'Incline barbell press', 'Low-incline Smith press'] },
  flat_mach_press: { name: 'Machine chest press', m: 'Mid chest, triceps', cue: 'Seat height so handles sit at mid-chest. Drive through, squeeze chest at lockout without rolling shoulders forward.', sub: ['Flat dumbbell press', 'Barbell bench press'] },
  bench_press:     { name: 'Barbell bench press', m: 'Chest, triceps, front delt', cue: 'Feet planted, slight arch, bar to lower chest. Touch, pause a beat, press. Always use a spotter or safeties.', sub: ['Flat dumbbell press', 'Machine chest press'] },
  cable_fly_low:   { name: 'Low-to-high cable fly', m: 'Upper chest', cue: 'Pulleys at the bottom. Slight elbow bend locked in. Sweep up and in until hands meet at upper chest, squeeze 1 s. Light weight, perfect form.', sub: ['Incline dumbbell fly', 'Pec deck (seat low)'] },
  pec_deck:        { name: 'Pec deck / cable fly', m: 'Chest', cue: 'Elbows slightly below shoulder height. Open to a stretch you can control, close with the chest, not the hands.', sub: ['Flat cable fly', 'Dumbbell fly'] },
  dips:            { name: 'Chest dips (assisted if needed)', m: 'Lower chest, triceps', cue: 'Lean forward 20–30°, elbows out slightly, descend until upper arm is parallel. Stop if the front of the shoulder hurts.', sub: ['Decline machine press', 'Machine dip'] },

  cs_row:          { name: 'Chest-supported row', m: 'Upper back, lats, rear delt, biceps', cue: 'Chest glued to the pad. Pull elbows back and down, pause 1 s with shoulder blades squeezed. No heaving.', sub: ['Seated cable row', 'T-bar row', 'Machine row'] },
  cable_row:       { name: 'Seated cable row', m: 'Mid back, lats, biceps', cue: 'Torso upright and still. Pull to the lower ribs, elbows close. Let the shoulders protract forward on the stretch.', sub: ['Chest-supported row', 'Machine row'] },
  lat_pulldown:    { name: 'Lat pulldown', m: 'Lats, biceps', cue: 'Grip just wider than shoulders. Lean back 10–15°, pull the bar to the upper chest while driving elbows to the hips. Control the way up.', sub: ['Assisted pull-up', 'Neutral-grip pulldown'] },
  pullup:          { name: 'Pull-up (band or machine assisted)', m: 'Lats, biceps, grip', cue: 'Start from a dead hang. Chin over bar, then lower in 2–3 s. Use assistance so every set hits the target reps.', sub: ['Lat pulldown', 'Neutral-grip pulldown'] },
  db_row:          { name: 'One-arm dumbbell row', m: 'Lats, mid back, biceps', cue: 'Knee and hand on the bench. Row to the hip, not the armpit. Pause at the top; let the weight stretch you at the bottom.', sub: ['Single-arm cable row', 'Machine row'] },
  face_pull:       { name: 'Face pull', m: 'Rear delt, rotator cuff, upper back', cue: 'Rope at face height. Pull toward the forehead, elbows high, finish with fists beside the ears. This keeps shoulders healthy.', sub: ['Rear delt fly', 'Band pull-apart'] },

  db_shoulder_press:{ name: 'Seated dumbbell shoulder press', m: 'Front and side delts, triceps', cue: 'Back pad slightly short of vertical. Dumbbells to ear height, press up and slightly in. Do not flare the ribs.', sub: ['Machine shoulder press', 'Standing barbell press'] },
  ohp:             { name: 'Standing barbell overhead press', m: 'Delts, triceps, core', cue: 'Bar on the collarbone, squeeze glutes, press straight up and push the head through at the top.', sub: ['Seated dumbbell shoulder press', 'Machine shoulder press'] },
  lat_raise:       { name: 'Cable lateral raise', m: 'Side delt', cue: 'Cable set low, handle crossing the body. Lead with the elbow, raise to shoulder height, lower slowly. Light, strict, lots of reps.', sub: ['Dumbbell lateral raise', 'Machine lateral raise'] },

  inc_db_curl:     { name: 'Incline dumbbell curl', m: 'Biceps (long head, stretched position)', cue: 'Bench at 45–60°, arms hanging straight down behind you. Curl without moving the upper arm, lower all the way. This is your main biceps builder.', sub: ['Bayesian cable curl', 'Seated dumbbell curl'] },
  preacher_curl:   { name: 'Preacher curl (EZ-bar or machine)', m: 'Biceps (short head, peak contraction)', cue: 'Armpits over the top of the pad. Lower until the arm is almost straight, curl until the forearm is vertical. No swinging.', sub: ['Machine preacher curl', 'Spider curl'] },
  hammer_curl:     { name: 'Hammer curl', m: 'Brachialis, brachioradialis, biceps', cue: 'Neutral grip, thumbs up. Curl to shoulder height, elbows pinned. Builds arm thickness and width.', sub: ['Rope cable hammer curl', 'Cross-body hammer curl'] },
  bayesian_curl:   { name: 'Bayesian cable curl', m: 'Biceps (long head, stretched)', cue: 'Face away from a low pulley, step forward so the arm is pulled behind you. Curl with the upper arm fixed. Deep stretch, slow negative.', sub: ['Incline dumbbell curl'] },
  ez_curl:         { name: 'EZ-bar curl', m: 'Biceps', cue: 'Elbows tucked at the sides, curl to the chest, 2 s negative. Pick a weight you can lift strictly.', sub: ['Barbell curl', 'Cable curl'] },

  pushdown:        { name: 'Rope triceps pushdown', m: 'Triceps (lateral head)', cue: 'Elbows pinned to the sides. Push down and split the rope at the bottom. Keep the shoulders still.', sub: ['Straight-bar pushdown', 'Machine triceps extension'] },
  oh_tri_ext:      { name: 'Overhead cable triceps extension', m: 'Triceps (long head)', cue: 'Face away from the cable, rope behind the head. Extend until arms are straight, let the rope stretch the triceps on the way back.', sub: ['Dumbbell overhead extension', 'Skull crusher'] },
  skullcrusher:    { name: 'EZ-bar skull crusher', m: 'Triceps', cue: 'Lower the bar behind the top of the head, not to the forehead. Elbows pointed at the ceiling.', sub: ['Overhead cable triceps extension'] },

  leg_press:       { name: 'Leg press', m: 'Quads, glutes', cue: 'Feet shoulder width, mid-platform. Lower until thighs touch the torso without the lower back rounding. Do not lock knees hard.', sub: ['Hack squat', 'Goblet squat'] },
  hack_squat:      { name: 'Hack squat', m: 'Quads, glutes', cue: 'Feet lower on the platform for more quad. Go deep, drive through the whole foot.', sub: ['Leg press', 'Back squat'] },
  goblet_squat:    { name: 'Goblet squat', m: 'Quads, glutes, core', cue: 'Dumbbell held at the chest, elbows inside the knees at the bottom, chest tall. Good re-entry squat for week 1–3.', sub: ['Leg press', 'Back squat'] },
  back_squat:      { name: 'Barbell back squat', m: 'Quads, glutes, core', cue: 'Bar on the upper back, brace hard, sit down between the hips, drive up. Depth: hip crease at or below knee.', sub: ['Hack squat', 'Leg press'] },
  rdl:             { name: 'Romanian deadlift (dumbbell or barbell)', m: 'Hamstrings, glutes, lower back', cue: 'Soft knees, push hips back, bar stays touching the thighs. Stop when the hamstrings are fully stretched (usually mid-shin). Flat back the whole time.', sub: ['45° back extension', 'Lying leg curl'] },
  hip_thrust:      { name: 'Barbell hip thrust', m: 'Glutes, hamstrings', cue: 'Upper back on a bench, shins vertical at the top, chin tucked. Squeeze glutes hard for 1 s at the top.', sub: ['Machine hip thrust', 'Glute bridge'] },
  bss:             { name: 'Bulgarian split squat', m: 'Quads, glutes (single leg)', cue: 'Rear foot on a bench, front shin near vertical. Lower until the rear knee almost touches. Hold dumbbells only once bodyweight is easy.', sub: ['Walking lunge', 'Reverse lunge'] },
  walking_lunge:   { name: 'Walking lunge', m: 'Quads, glutes', cue: 'Long step, torso upright, rear knee to just above the floor. Push through the front heel.', sub: ['Bulgarian split squat', 'Reverse lunge'] },
  leg_curl:        { name: 'Lying or seated leg curl', m: 'Hamstrings', cue: 'Curl all the way, 2–3 s on the way back. Point toes to make it harder.', sub: ['Nordic curl (eccentric only)', 'Swiss ball leg curl'] },
  leg_ext:         { name: 'Leg extension', m: 'Quads (rectus femoris)', cue: 'Lean back slightly, extend fully, squeeze 1 s, lower under control.', sub: ['Sissy squat', 'Goblet squat (high reps)'] },
  calf_stand:      { name: 'Standing calf raise', m: 'Gastrocnemius', cue: 'Full stretch at the bottom for 1 s, full rise, no bouncing. The bottom position is where calves grow.', sub: ['Leg-press calf raise', 'Smith-machine calf raise'] },
  calf_seated:     { name: 'Seated calf raise', m: 'Soleus', cue: 'Same rule: pause at the stretch, slow tempo, high reps.', sub: ['Standing calf raise'] },
  cable_crunch:    { name: 'Cable crunch', m: 'Abs', cue: 'Kneel, rope behind the head, curl the ribs toward the pelvis. Hips stay still.', sub: ['Machine crunch', 'Weighted decline crunch'] },
  hanging_knee_raise:{ name: 'Hanging knee raise', m: 'Lower abs, hip flexors', cue: 'Tilt the pelvis up at the top (tuck the tailbone). Slow, no swinging. Use captain’s chair if grip gives out.', sub: ['Reverse crunch', 'Lying leg raise'] },
  plank:           { name: 'Plank or ab-wheel rollout', m: 'Core', cue: 'Ribs down, glutes tight, hold 30–60 s or 6–10 controlled rollouts.', sub: ['Dead bug', 'Hollow hold'] },
  incline_walk:    { name: 'Incline treadmill walk (zone 2)', m: 'Cardio, fat loss', cue: '10–12% incline, 5–6 km/h, 20–30 min. You should be able to talk in short sentences. No sprinting required.', sub: ['Bike (easy pace)', 'Stairmaster (slow)', '30-minute outdoor brisk walk'] },
};

/* ---------- Helpers for prescriptions ---------- */
const X = (ex, sets, reps, rest, opts = {}) => ({ ex, sets, reps, rest, ...opts });

/* ---------- Splits ---------- */
/* Each split: pattern is 7 slots starting on Day 1 (Day 1 = your first training day). */
R100.SPLITS = {
  ul4: {
    name: 'Upper / Lower — 4 days',
    short: 'U/L 4-day',
    recommended: true,
    tag: 'Recommended start',
    why: 'Every muscle is trained twice a week, which beats once-a-week when total sets are equal. Four sessions leave three recovery days, which matters while your joints and tendons re-adapt. Direct biceps work fits three times a week without exhausting you.',
    pattern: ['ua', 'la', null, 'ub', 'lb', null, null],
    workouts: {
      ua: { name: 'Upper A — Chest & back strength', focus: 'Upper chest, back, biceps', items: [
        X('inc_db_press', 3, '8–10', 150, { priority: true, note: 'Main lift. Upper chest first while fresh.' }),
        X('cs_row', 3, '8–10', 120),
        X('flat_mach_press', 2, '10–12', 90),
        X('lat_pulldown', 3, '10–12', 90),
        X('db_shoulder_press', 2, '10–12', 90),
        X('inc_db_curl', 3, '10–12', 75, { priority: true, note: 'Biceps priority. Full stretch at the bottom.' }),
        X('pushdown', 2, '12–15', 60),
        X('cable_fly_low', 2, '12–15', 60, { priority: true, note: 'Upper chest finisher. Light, squeeze.' }),
      ]},
      la: { name: 'Lower A — Quads & posterior', focus: 'Quads, hamstrings, calves, abs', items: [
        X('leg_press', 3, '8–10', 150, { note: 'Weeks 1–3 you may use goblet squat if you prefer.' }),
        X('rdl', 3, '8–10', 150),
        X('bss', 2, '10 / leg', 90),
        X('leg_curl', 2, '12–15', 75),
        X('calf_stand', 3, '12–15', 60),
        X('hanging_knee_raise', 3, '12–15', 60),
        X('incline_walk', 1, '20 min', 0, { cardio: true, note: 'Optional: do it here, or take a 30-minute route home instead of the 12-minute one.' }),
      ]},
      ub: { name: 'Upper B — Back & arms', focus: 'Lats, side delts, biceps, triceps', items: [
        X('pullup', 3, '6–10', 150, { note: 'Assisted is fine. Goal: 3×10 unassisted by Day 100.' }),
        X('inc_db_press', 3, '10–12', 120, { priority: true, note: 'Second upper-chest exposure, lighter and higher reps.' }),
        X('db_row', 3, '10–12', 90),
        X('lat_raise', 3, '12–15', 60),
        X('pec_deck', 2, '12–15', 60),
        X('preacher_curl', 3, '8–12', 75, { priority: true }),
        X('hammer_curl', 2, '10–12', 60, { priority: true }),
        X('oh_tri_ext', 2, '12–15', 60),
        X('face_pull', 2, '15–20', 45),
      ]},
      lb: { name: 'Lower B — Hips & arms finisher', focus: 'Quads, glutes, calves, core, biceps touch-up', items: [
        X('hack_squat', 3, '10–12', 150, { note: 'Or leg press with feet lower on the platform.' }),
        X('hip_thrust', 3, '10–12', 120),
        X('leg_ext', 2, '12–15', 75),
        X('leg_curl', 2, '12–15', 75),
        X('calf_seated', 3, '15–20', 60),
        X('plank', 3, '30–60 s', 60),
        X('bayesian_curl', 2, '12–15', 60, { priority: true, note: 'Third biceps exposure of the week. Light, slow.' }),
        X('incline_walk', 1, '20 min', 0, { cardio: true, note: 'Optional: or the long route home.' }),
      ]},
    },
  },

  fb3: {
    name: 'Full Body — 3 days',
    short: 'Full body 3-day',
    tag: 'Busy weeks',
    why: 'Three sessions, every muscle three times a week at lower volume per session. Use it on travel weeks or if life only allows three gym days. Progress is slower on arms and upper chest because there is less room for isolation work.',
    pattern: ['fa', null, 'fb', null, 'fc', null, null],
    workouts: {
      fa: { name: 'Full Body A', focus: 'Squat pattern, horizontal push/pull', items: [
        X('leg_press', 3, '8–10', 150), X('inc_db_press', 3, '8–10', 120, { priority: true }), X('cs_row', 3, '8–10', 120),
        X('leg_curl', 2, '12–15', 75), X('inc_db_curl', 3, '10–12', 75, { priority: true }), X('pushdown', 2, '12–15', 60), X('hanging_knee_raise', 2, '12–15', 60),
      ]},
      fb: { name: 'Full Body B', focus: 'Hinge, vertical push/pull', items: [
        X('rdl', 3, '8–10', 150), X('lat_pulldown', 3, '10–12', 120), X('db_shoulder_press', 3, '10–12', 120),
        X('bss', 2, '10 / leg', 90), X('preacher_curl', 3, '8–12', 75, { priority: true }), X('lat_raise', 2, '12–15', 60), X('calf_stand', 3, '12–15', 60),
      ]},
      fc: { name: 'Full Body C', focus: 'Volume day', items: [
        X('hack_squat', 3, '10–12', 150), X('flat_mach_press', 3, '10–12', 120), X('db_row', 3, '10–12', 90),
        X('cable_fly_low', 2, '12–15', 60, { priority: true }), X('hammer_curl', 2, '10–12', 60, { priority: true }), X('face_pull', 2, '15–20', 45), X('plank', 3, '30–60 s', 60),
      ]},
    },
  },

  ulppl5: {
    name: 'Upper / Lower / Push / Pull / Legs — 5 days',
    short: 'U/L + PPL 5-day',
    tag: 'Phase 3',
    why: 'The natural next step after Upper/Lower. Still twice-a-week frequency, but the push and pull days add arm and chest volume without making the upper days two hours long. This is what the plan switches to on Day 57, unless you prefer to stay on 4 days.',
    pattern: ['u', 'l', null, 'push', 'pull', 'legs', null],
    workouts: {
      u: { name: 'Upper — Strength', focus: 'Heavy compounds', items: [
        X('inc_db_press', 4, '6–8', 180, { priority: true }), X('cs_row', 4, '6–8', 150), X('ohp', 3, '6–8', 150),
        X('pullup', 3, '6–10', 150), X('ez_curl', 3, '8–10', 75, { priority: true }), X('skullcrusher', 2, '10–12', 75),
      ]},
      l: { name: 'Lower — Strength', focus: 'Heavy squat and hinge', items: [
        X('back_squat', 4, '5–8', 180, { note: 'Or hack squat if you do not have a confident squat yet.' }), X('rdl', 3, '6–8', 150),
        X('walking_lunge', 2, '10 / leg', 90), X('leg_curl', 2, '10–12', 75), X('calf_stand', 4, '10–12', 60), X('cable_crunch', 3, '12–15', 60),
      ]},
      push: { name: 'Push — Chest & triceps volume', focus: 'Upper chest emphasis', items: [
        X('inc_db_press', 3, '10–12', 120, { priority: true }), X('flat_mach_press', 3, '10–12', 90), X('cable_fly_low', 3, '12–15', 60, { priority: true }),
        X('db_shoulder_press', 3, '10–12', 90), X('lat_raise', 4, '12–15', 60), X('oh_tri_ext', 3, '12–15', 60), X('pushdown', 2, '15–20', 45),
      ]},
      pull: { name: 'Pull — Back & biceps volume', focus: 'Biceps emphasis', items: [
        X('lat_pulldown', 3, '10–12', 90), X('db_row', 3, '10–12', 90), X('cable_row', 2, '12–15', 75), X('face_pull', 3, '15–20', 45),
        X('inc_db_curl', 4, '10–12', 75, { priority: true }), X('preacher_curl', 3, '10–12', 75, { priority: true }), X('hammer_curl', 3, '10–12', 60, { priority: true }),
      ]},
      legs: { name: 'Legs — Volume', focus: 'Quads, glutes, calves', items: [
        X('hack_squat', 3, '10–12', 150), X('hip_thrust', 3, '10–12', 120), X('bss', 2, '10–12 / leg', 90),
        X('leg_ext', 3, '12–15', 60), X('leg_curl', 3, '12–15', 60), X('calf_seated', 4, '15–20', 45), X('plank', 3, '45–60 s', 60),
      ]},
    },
  },

  ppl6: {
    name: 'Push / Pull / Legs — 6 days',
    short: 'PPL 6-day',
    tag: 'Advanced',
    why: 'Highest weekly volume, each muscle twice a week, one rest day. Only worth it once you recover well, sleep 7–9 h and have the schedule. Six days in a row of commuting to the gym is where most people fall off the plan.',
    pattern: ['push1', 'pull1', 'legs1', 'push2', 'pull2', 'legs2', null],
    workouts: {
      push1: { name: 'Push 1 — Strength', focus: 'Chest, delts, triceps', items: [
        X('inc_db_press', 4, '6–8', 180, { priority: true }), X('flat_mach_press', 3, '8–10', 120), X('ohp', 3, '6–8', 150), X('lat_raise', 3, '12–15', 60), X('skullcrusher', 3, '10–12', 75),
      ]},
      pull1: { name: 'Pull 1 — Strength', focus: 'Back, biceps', items: [
        X('pullup', 4, '6–10', 150), X('cs_row', 4, '6–8', 150), X('face_pull', 3, '15–20', 45), X('ez_curl', 3, '8–10', 75, { priority: true }), X('hammer_curl', 3, '10–12', 60, { priority: true }),
      ]},
      legs1: { name: 'Legs 1 — Strength', focus: 'Squat, hinge', items: [
        X('back_squat', 4, '5–8', 180), X('rdl', 3, '6–8', 150), X('leg_ext', 3, '12–15', 60), X('calf_stand', 4, '10–12', 60), X('cable_crunch', 3, '12–15', 60),
      ]},
      push2: { name: 'Push 2 — Volume', focus: 'Upper chest emphasis', items: [
        X('inc_db_press', 3, '10–12', 120, { priority: true }), X('cable_fly_low', 3, '12–15', 60, { priority: true }), X('dips', 3, '8–12', 120), X('db_shoulder_press', 3, '10–12', 90), X('lat_raise', 4, '12–15', 60), X('oh_tri_ext', 3, '12–15', 60),
      ]},
      pull2: { name: 'Pull 2 — Volume', focus: 'Biceps emphasis', items: [
        X('lat_pulldown', 3, '10–12', 90), X('db_row', 3, '10–12', 90), X('cable_row', 3, '12–15', 75), X('inc_db_curl', 4, '10–12', 75, { priority: true }), X('preacher_curl', 3, '10–12', 75, { priority: true }), X('bayesian_curl', 2, '12–15', 60, { priority: true }),
      ]},
      legs2: { name: 'Legs 2 — Volume', focus: 'Quads, glutes, hamstrings', items: [
        X('hack_squat', 3, '10–12', 150), X('hip_thrust', 3, '10–12', 120), X('bss', 3, '10 / leg', 90), X('leg_curl', 3, '12–15', 60), X('calf_seated', 4, '15–20', 45), X('plank', 3, '45–60 s', 60),
      ]},
    },
  },

  bro5: {
    name: 'Body-part split — 5 days',
    short: 'Bro split',
    tag: 'Not recommended',
    why: 'Each muscle once a week. Included so you can see it, not so you use it: with equal weekly sets, once-a-week frequency grows muscle slower, and for a returning lifter the per-session damage is high. If you love it, use it after Day 100, not before.',
    pattern: ['chest', 'back', 'shoulders', 'legs', 'arms', null, null],
    workouts: {
      chest: { name: 'Chest', focus: 'Chest', items: [X('inc_db_press', 4, '8–10', 150, { priority: true }), X('bench_press', 3, '8–10', 150), X('cable_fly_low', 3, '12–15', 60, { priority: true }), X('pec_deck', 3, '12–15', 60), X('dips', 3, '8–12', 120)] },
      back:  { name: 'Back', focus: 'Back', items: [X('pullup', 4, '6–10', 150), X('cs_row', 4, '8–10', 120), X('lat_pulldown', 3, '10–12', 90), X('cable_row', 3, '12–15', 75), X('face_pull', 3, '15–20', 45)] },
      shoulders: { name: 'Shoulders', focus: 'Delts', items: [X('ohp', 4, '6–8', 150), X('db_shoulder_press', 3, '10–12', 90), X('lat_raise', 4, '12–15', 60), X('face_pull', 3, '15–20', 45), X('cable_crunch', 3, '12–15', 60)] },
      legs:  { name: 'Legs', focus: 'Legs', items: [X('back_squat', 4, '6–8', 180), X('rdl', 3, '8–10', 150), X('leg_press', 3, '10–12', 120), X('leg_curl', 3, '12–15', 60), X('leg_ext', 3, '12–15', 60), X('calf_stand', 4, '12–15', 60)] },
      arms:  { name: 'Arms', focus: 'Biceps, triceps', items: [X('inc_db_curl', 4, '10–12', 75, { priority: true }), X('preacher_curl', 3, '10–12', 75, { priority: true }), X('hammer_curl', 3, '10–12', 60, { priority: true }), X('skullcrusher', 3, '10–12', 75), X('oh_tri_ext', 3, '12–15', 60), X('pushdown', 3, '15–20', 45)] },
    },
  },
};

/* ---------- The 100-day plan ---------- */
R100.PHASES = [
  { id: 'p1', name: 'Phase 1 · Rebuild', from: 1, to: 21, split: 'ul4', rpe: '6–7', setMod: -1,
    kcalOffset: -200, rateTarget: [-0.5, -0.2],
    goal: 'Re-learn the movements, wake up muscle memory, start dropping fat. Leave 3–4 reps in the tank on every set. Soreness in week 1 is expected; it fades by week 2.',
    rules: ['Stop every set with 3–4 reps left (RPE 6–7).', 'Add weight only when all sets hit the top of the rep range.', 'Walk 8,000–10,000 steps every day.', 'Protein target every single day, even on rest days.'] },
  { id: 'p2', name: 'Phase 2 · Build', from: 22, to: 49, split: 'ul4', rpe: '7–8', setMod: 0,
    kcalOffset: 0, rateTarget: [-0.2, 0.2],
    goal: 'Full working volume. Weights climb every week on the main lifts. Body weight roughly flat while the waist shrinks: that is muscle replacing fat.',
    rules: ['Stop every set with 2–3 reps left (RPE 7–8).', 'Last set of each exercise may go to 1 rep in reserve.', 'Two 20–30 min incline walks a week on top of steps.', 'Weigh in daily, judge by the 7-day average only.'] },
  { id: 'deload', name: 'Deload week', from: 50, to: 56, split: 'ul4', rpe: '5–6', setMod: 'deload',
    kcalOffset: -100, rateTarget: [-0.3, 0.2],
    goal: 'Same exercises, 2 sets each, 20% less weight, nothing near failure. Joints, tendons and nervous system catch up so Phase 3 can be pushed hard.',
    rules: ['2 sets per exercise, drop 20% of the weight.', 'Keep steps and protein exactly the same.', 'Sleep 8 h if you can. This week is where growth consolidates.'] },
  { id: 'p3', name: 'Phase 3 · Push', from: 57, to: 100, split: 'ulppl5', rpe: '8–9', setMod: 1,
    kcalOffset: 200, rateTarget: [0.2, 0.4],
    goal: 'Five days a week, extra sets on upper chest and biceps, small calorie surplus to add lean weight. If five days does not fit your life, stay on Upper/Lower in Settings and the plan still works.',
    rules: ['Work sets at RPE 8–9 (1–2 reps left), last set of isolation work to failure.', 'Surplus is small on purpose: +0.2 to +0.4 kg per week, no more.', 'If the waist grows more than 1 cm in two weeks, cut 150 kcal.'] },
];

R100.TOTAL_DAYS = 100;

/* ---------- Guide content ---------- */
R100.GUIDE = {
  warmup: [
    'Your walk to the gym (about 1,500 steps, 12 minutes) is the general warm-up. Walk briskly enough to arrive warm, not strolling.',
    'Early-morning joints and spine are stiffer than afternoon ones: 2–3 minutes inside the gym before touching a weight. Arm circles, band pull-aparts ×15, bodyweight squats ×10, hip hinges ×10, cat-cow ×8.',
    'First compound lift of the day: empty or very light ×12, 50% of work weight ×8, 75% ×4, then work sets. On lower days add one more ramp set before squats and RDLs because the lower back is least ready first thing.',
    'Later exercises need one light set of 8–10 at most.',
    'The walk home is the cool-down. On lower days the optional 20-minute incline walk is still the fat-loss tool: do it in the gym or take a 30-minute route home instead.',
  ],
  morning: [
    'Sleep is the constraint, not the alarm. Waking at 5 means lights out by 21:00–21:30 for 7.5–8 hours. Train at 6 after a midnight bedtime and you will lose the plan by week 3. If 21:30 is impossible on some nights, train at 7 and wake at 6: one hour between waking and lifting is enough.',
    'Weigh in straight after the toilet, before any food or drink. That is the only reading that is comparable day to day.',
    'Eat something small 30–45 minutes before lifting: fast carbs plus some protein. A banana and a scoop of whey in water, or 200 g Greek yoghurt with honey. Training heavy fully fasted costs reps; training on a full breakfast costs comfort. Coffee is fine and helps.',
    'Breakfast proper within an hour of getting home. This is the biggest meal of the day and carries 40–50 g of protein.',
    'Lay out clothes, shoes, headphones and the pre-workout snack the night before. Decisions at 5 AM are where mornings die.',
  ],
  progression: [
    'Double progression: each exercise has a rep range (say 8–10). Keep the same weight until you hit the top number on every set with the phase’s reps in reserve.',
    'Then add the smallest jump: +2.5 kg on upper-body lifts, +5 kg on leg press/hack squat, next dumbbell up on dumbbell work.',
    'If you miss the bottom of the range on two sets, the weight is too heavy. Drop 5–10% next time.',
    'The app shows your last session beside every exercise and flags when you have earned a jump.',
  ],
  rpe: [
    'RPE = how hard the set was out of 10. RPE 7 means you could have done 3 more reps. RPE 9 means 1 more rep.',
    'Muscle grows from hard sets, not from failure every set. Failure on isolation work (curls, flys, raises) is fine. Failure on heavy compounds costs recovery and is not worth it in the first 7 weeks.',
  ],
  chest: {
    title: 'Your chest: what training can and cannot fix',
    body: [
      'You were 103 kg at 15. Chest fullness that lingers after big weight loss is usually one of three things: leftover fat, stretched skin, or glandular tissue (true gynecomastia) that formed during puberty when body fat and hormones were high.',
      'Fat responds to a calorie deficit and training. Skin tightens somewhat over years, especially at 21, but slowly. Gland does not respond to either; it is a firm, rubbery disc directly under the nipple that you can feel with a pinch. Only a hands-on exam can tell them apart, so get a GP or endocrinologist to check once. If it is gland, surgery is the fix and no number of push-ups changes that, so do not judge your training by it.',
      'What training does change: building the upper chest (incline press, low-to-high fly) lifts the whole chest visually and makes the lower fullness far less noticeable. Lowering body fat does the rest for the fat component. That is why every upper day in this plan starts with the incline press.',
      'Avoid: endless flat bench and dips only. Those build the lower and mid chest, which is the part you want to appear smaller, not bigger.',
    ],
  },
  biceps: {
    title: 'Biceps: the specialisation rules',
    body: [
      'Direct biceps work three times a week: 10–12 hard sets in Phase 1–2, 14–16 in Phase 3. Plus every row and pulldown counts as indirect work.',
      'Three angles, each hitting the muscle differently: stretched (incline or Bayesian curl), mid-range (EZ-bar or dumbbell curl), shortened (preacher). The plan rotates all three.',
      'Hammer curls grow the brachialis, which sits under the biceps and pushes it up. That is where visible arm thickness comes from.',
      'Form over load: full range, 2 s negative, no swinging. A strict 12 kg curl builds more arm than a cheated 20 kg one.',
      'Realistic 100-day expectation with muscle memory: +1 to +2 cm on a cold, flexed arm measurement. Measure Day 1, Day 50 and Day 100, same arm, same time of day.',
    ],
  },
  fatloss: {
    title: 'How to lower body fat without losing the muscle you came back for',
    body: [
      'You cannot do both a real bulk and a real cut at once. The plan does a recomposition: a small deficit for three weeks while muscle memory refills size quickly, then maintenance, then a small surplus. The scale will move less than you want; the mirror and the waist tape will move more.',
      'Protein is the non-negotiable: about 2.1 g per kg of body weight (around 160–170 g a day for you). It protects muscle in the deficit and builds it in the surplus.',
      'Steps are the cheapest fat-loss tool. 8,000–10,000 a day burns 300–500 kcal more than sitting and does not interfere with lifting. Two short incline walks a week on top.',
      'Sleep 7–9 h. Under 6 h, fat loss shifts toward muscle loss and your lifts stall. This matters more than any supplement.',
      'Judge progress by the 7-day average weight, the waist at the navel, and the weights on the bar. Daily weight swings 1–2 kg from water and food; ignore single readings.',
      'Supplements that are worth it: creatine monohydrate 5 g daily (adds 1–2 kg of water weight in the muscle in week 1, that is normal), whey protein if food alone cannot hit the protein target, caffeine before training if you like it. Nothing else is needed.',
    ],
  },
  expectations: {
    title: 'What 100 days can and cannot deliver',
    body: [
      'Honest numbers: with muscle memory, a 21-year-old re-training hard can regain 3–4 kg of lean mass in 100 days while losing 2–3 kg of fat. Net scale change: roughly +1 to +3 kg. Expect to finish around 78–80 kg looking much leaner than 76.7 kg looks now.',
      '82–85 kg lean is a 6–9 month goal, not a 100-day one. Anyone who promises +7 kg of muscle in 14 weeks is selling you fat gain.',
      'Markers that you are winning: waist down 3–5 cm, incline dumbbell press up 30–40%, pull-ups from assisted to unassisted, arm up 1–2 cm.',
    ],
  },
};

/* ---------- Sample day of eating (edit freely) ---------- */
R100.MEALS = [
  { when: 'Pre-gym (30–45 min before)', food: '1 banana + 1 scoop whey in water, black coffee, 500 ml water', p: 25, kcal: 220 },
  { when: 'Breakfast (after the walk home)', food: '4 whole eggs + 150 g egg whites, 80 g oats with milk, berries', p: 50, kcal: 750 },
  { when: 'Lunch', food: '200 g chicken breast (cooked), 250 g cooked rice, vegetables, 1 tbsp olive oil', p: 60, kcal: 800 },
  { when: 'Afternoon', food: '250 g Greek yoghurt (0–2%), 1 apple, handful of nuts', p: 25, kcal: 400 },
  { when: 'Dinner (by 19:30)', food: '180 g lean beef or fish, potatoes or pasta, salad', p: 45, kcal: 650 },
];
