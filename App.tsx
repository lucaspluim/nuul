import { useEffect, useRef, useState, useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { StatusBar } from "expo-status-bar";
import {
  StyleSheet,
  View,
  Text,
  Dimensions,
  PanResponder,
  Animated,
  Easing,
  AppState,
} from "react-native";
import { WebView } from "react-native-webview";
import { Audio } from "expo-av";
import * as Haptics from "expo-haptics";
import { Accelerometer } from "expo-sensors";
import Svg, { Defs, RadialGradient, Stop, Circle } from "react-native-svg";

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");

type NoiseType = "white" | "pink" | "brown";

const NOISE_COLORS: Record<NoiseType, [number, number, number]> = {
  white: [245, 245, 245],
  pink: [245, 198, 208],
  brown: [139, 105, 20],
};

const NOISE_ORDER: NoiseType[] = ["white", "pink", "brown"];

const CROSSFADE_MS = 1500;

// ─── Soft Orb (GPU-rendered radial gradient) ───────────────────────
const ORB_SIZE = 220;

const ORB_COLORS: Record<NoiseType, string> = {
  white: "rgba(150,150,165,",  // cool grey on white
  pink: "rgba(170,90,115,",    // deeper rose on pink
  brown: "rgba(70,50,5,",      // darker amber on brown
};

function Orb({ opacity, scale, x, y, noiseType }: {
  opacity: Animated.Value | Animated.AnimatedInterpolation<number>;
  scale: Animated.Value | Animated.AnimatedInterpolation<number>;
  x: Animated.Value | number;
  y: Animated.Value | number;
  noiseType: NoiseType;
}) {
  const c = ORB_COLORS[noiseType];
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: SCREEN_W / 2 - ORB_SIZE / 2,
        top: SCREEN_H / 2 - ORB_SIZE / 2,
        width: ORB_SIZE,
        height: ORB_SIZE,
        opacity,
        transform: [
          { translateX: x as any },
          { translateY: y as any },
          { scale: scale as any },
        ],
      }}
    >
      <Svg width={ORB_SIZE} height={ORB_SIZE} viewBox={`0 0 ${ORB_SIZE} ${ORB_SIZE}`}>
        <Defs>
          <RadialGradient id="orb" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={`${c}1)`} stopOpacity="0.7" />
            <Stop offset="15%" stopColor={`${c}1)`} stopOpacity="0.55" />
            <Stop offset="35%" stopColor={`${c}1)`} stopOpacity="0.3" />
            <Stop offset="60%" stopColor={`${c}1)`} stopOpacity="0.12" />
            <Stop offset="85%" stopColor={`${c}1)`} stopOpacity="0.03" />
            <Stop offset="100%" stopColor={`${c}1)`} stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Circle cx={ORB_SIZE / 2} cy={ORB_SIZE / 2} r={ORB_SIZE / 2} fill="url(#orb)" />
      </Svg>
    </Animated.View>
  );
}

// ─── Tutorial Steps ────────────────────────────────────────────────
type TutorialStep = "tap" | "doubleTap" | "dragV" | "dragH" | "done";

const TUTORIAL_HINTS: Record<Exclude<TutorialStep, "done">, string> = {
  tap: "Tap to play",
  doubleTap: "Double tap to\nchange noise",
  dragV: "Drag down to\nchange tone",
  dragH: "Drag right to\nadd space",
};

const TUTORIAL_TEXT_COLORS: Record<NoiseType, string> = {
  white: "rgba(0,0,0,0.3)",
  pink: "rgba(120,50,70,0.35)",
  brown: "rgba(60,40,5,0.5)",
};


// Two orb+text layers (A/B) for crossfading between steps.
// Text stays visible throughout a step; only the orb pulses in/out.
function useTutorialAnimations(step: TutorialStep) {
  const aOp = useRef(new Animated.Value(0)).current;
  const aSc = useRef(new Animated.Value(1)).current;
  const aX = useRef(new Animated.Value(0)).current;
  const aY = useRef(new Animated.Value(0)).current;
  const aTx = useRef(new Animated.Value(0)).current;

  const bOp = useRef(new Animated.Value(0)).current;
  const bSc = useRef(new Animated.Value(1)).current;
  const bX = useRef(new Animated.Value(0)).current;
  const bY = useRef(new Animated.Value(0)).current;
  const bTx = useRef(new Animated.Value(0)).current;

  const active = useRef<"A" | "B">("A");
  const animRef = useRef<Animated.CompositeAnimation | null>(null);
  const firstRun = useRef(true);
  // Track which step each layer is displaying
  const [stepA, setStepA] = useState<TutorialStep>("tap");
  const [stepB, setStepB] = useState<TutorialStep>("tap");

  useEffect(() => {
    if (step === "done") {
      if (animRef.current) animRef.current.stop();
      // Long, gentle fade out of both orb and text
      const cur = active.current === "A"
        ? { op: aOp, tx: aTx } : { op: bOp, tx: bTx };
      Animated.parallel([
        Animated.timing(cur.op, { toValue: 0, duration: 2500, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(cur.tx, { toValue: 0, duration: 3000, easing: Easing.out(Easing.ease), useNativeDriver: true }),
      ]).start();
      return;
    }

    const isFirst = firstRun.current;
    firstRun.current = false;

    // Pick incoming layer, fade out old
    if (!isFirst) {
      active.current = active.current === "A" ? "B" : "A";
    }

    // Assign the step text to the active layer
    if (active.current === "A") {
      setStepA(step);
    } else {
      setStepB(step);
    }

    const lay = active.current === "A"
      ? { op: aOp, sc: aSc, x: aX, y: aY, tx: aTx }
      : { op: bOp, sc: bSc, x: bX, y: bY, tx: bTx };
    const old = active.current === "A"
      ? { op: bOp, sc: bSc, x: bX, y: bY, tx: bTx }
      : { op: aOp, sc: aSc, x: aX, y: aY, tx: aTx };

    // Stop old orb loop
    if (animRef.current) { animRef.current.stop(); animRef.current = null; }

    // Reset incoming
    lay.op.setValue(0);
    lay.sc.setValue(1);
    lay.x.setValue(0);
    lay.y.setValue(0);

    // Crossfade old out
    if (!isFirst) {
      Animated.parallel([
        Animated.timing(old.op, { toValue: 0, duration: 400, useNativeDriver: true }),
        Animated.timing(old.tx, { toValue: 0, duration: 500, useNativeDriver: true }),
      ]).start();
    }

    // Fade in text (persists for entire step)
    Animated.timing(lay.tx, {
      toValue: 1,
      duration: isFirst ? 600 : 800,
      delay: isFirst ? 0 : 250,
      easing: Easing.out(Easing.ease),
      useNativeDriver: true,
    }).start();

    // Helpers
    const press = (dur = 200) =>
      Animated.sequence([
        Animated.timing(lay.sc, { toValue: 0.7, duration: dur, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(lay.sc, { toValue: 1.05, duration: dur * 1.8, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(lay.sc, { toValue: 1, duration: dur * 0.8, easing: Easing.out(Easing.ease), useNativeDriver: true }),
      ]);
    const orbIn = Animated.timing(lay.op, { toValue: 1, duration: 500, easing: Easing.out(Easing.ease), useNativeDriver: true });
    const orbOut = Animated.timing(lay.op, { toValue: 0, duration: 400, useNativeDriver: true });
    const wait = (ms: number) => Animated.delay(ms);
    const move = (target: Animated.Value, to: number, dur: number) =>
      Animated.timing(target, { toValue: to, duration: dur, easing: Easing.inOut(Easing.sin), useNativeDriver: true });

    let anim: Animated.CompositeAnimation;

    if (step === "tap") {
      anim = Animated.loop(Animated.sequence([
        orbIn, wait(300), press(180), wait(500), orbOut, wait(700),
      ]));
    } else if (step === "doubleTap") {
      anim = Animated.loop(Animated.sequence([
        orbIn, wait(250), press(120), wait(60), press(120), wait(500), orbOut, wait(700),
      ]));
    } else if (step === "dragV") {
      anim = Animated.loop(Animated.sequence([
        orbIn,
        Animated.parallel([
          press(300),
          Animated.sequence([
            wait(100), move(lay.y, 90, 1400), move(lay.y, -30, 1800), move(lay.y, 0, 800),
          ]),
        ]),
        orbOut, wait(500),
      ]));
    } else if (step === "dragH") {
      anim = Animated.loop(Animated.sequence([
        orbIn,
        Animated.parallel([
          press(300),
          Animated.sequence([
            wait(100), move(lay.x, 60, 1200), move(lay.x, -60, 2400), move(lay.x, 0, 1200),
          ]),
        ]),
        orbOut, wait(500),
      ]));
    } else {
      return;
    }

    const delay = isFirst ? 0 : 500;
    const timer = setTimeout(() => { animRef.current = anim; anim.start(); }, delay);

    return () => { clearTimeout(timer); if (animRef.current) animRef.current.stop(); };
  }, [step]);

  return {
    orbA: { opacity: aOp, scale: aSc, x: aX, y: aY },
    orbB: { opacity: bOp, scale: bSc, x: bX, y: bY },
    textAOpacity: aTx,
    textBOpacity: bTx,
    stepA,
    stepB,
  };
}

// ─── Audio HTML ────────────────────────────────────────────────────
const AUDIO_HTML = `
<!DOCTYPE html>
<html><body><script>
let ctx;
let currentType = 'white';
let isPlaying = false;
let currentFilterVal = 1.0;
let currentReverbVal = 0.0;

let chainA = null;
let chainB = null;
let activeChain = 'A';

function createReverb(audioCtx, duration, decay) {
  const rate = audioCtx.sampleRate;
  const length = rate * duration;
  const impulse = audioCtx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return impulse;
}

function generateNoise(type, bufferSize, sampleRate) {
  const output = new Float32Array(bufferSize);
  if (type === 'white') {
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }
  } else if (type === 'pink') {
    let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
    for (let i = 0; i < bufferSize; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886*b0 + w*0.0555179;
      b1 = 0.99332*b1 + w*0.0750759;
      b2 = 0.96900*b2 + w*0.1538520;
      b3 = 0.86650*b3 + w*0.3104856;
      b4 = 0.55000*b4 + w*0.5329522;
      b5 = -0.7616*b5 - w*0.0168980;
      output[i] = (b0+b1+b2+b3+b4+b5+b6+w*0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else if (type === 'brown') {
    let last = 0;
    for (let i = 0; i < bufferSize; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      output[i] = last * 3.5;
    }
  }
  return output;
}

let reverbBuffer = null;

function getReverbBuffer() {
  if (!reverbBuffer) {
    reverbBuffer = createReverb(ctx, 3, 2.5);
  }
  return reverbBuffer;
}

function buildChain(type) {
  const bufLen = ctx.sampleRate * 2;
  const noiseBuffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
  noiseBuffer.getChannelData(0).set(generateNoise(type, bufLen, ctx.sampleRate));

  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer;
  source.loop = true;

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  const minF = 200, maxF = 20000;
  filter.frequency.value = minF * Math.pow(maxF/minF, currentFilterVal);
  filter.Q.value = 0.5;

  const convolver = ctx.createConvolver();
  convolver.buffer = getReverbBuffer();

  const dryGain = ctx.createGain();
  dryGain.gain.value = 1 - currentReverbVal * 0.5;
  const wetGain = ctx.createGain();
  wetGain.gain.value = currentReverbVal;

  const masterGain = ctx.createGain();
  masterGain.gain.value = 0.0;

  source.connect(filter);
  filter.connect(dryGain);
  filter.connect(convolver);
  convolver.connect(wetGain);
  dryGain.connect(masterGain);
  wetGain.connect(masterGain);
  masterGain.connect(ctx.destination);

  source.start();

  return { source, filter, dryGain, wetGain, convolver, masterGain };
}

function destroyChain(chain) {
  if (!chain) return;
  try { chain.source.stop(); } catch(e){}
  try { chain.source.disconnect(); } catch(e){}
  try { chain.filter.disconnect(); } catch(e){}
  try { chain.dryGain.disconnect(); } catch(e){}
  try { chain.wetGain.disconnect(); } catch(e){}
  try { chain.convolver.disconnect(); } catch(e){}
  try { chain.masterGain.disconnect(); } catch(e){}
}

function applyFilterToChain(chain, value) {
  if (!chain || !chain.filter) return;
  const minF = 200, maxF = 20000;
  const freq = minF * Math.pow(maxF/minF, value);
  chain.filter.frequency.setTargetAtTime(freq, ctx.currentTime, 0.05);
}

function applyReverbToChain(chain, value) {
  if (!chain || !chain.dryGain) return;
  const dry = 1 - value * 0.5;
  chain.dryGain.gain.setTargetAtTime(dry, ctx.currentTime, 0.05);
  chain.wetGain.gain.setTargetAtTime(value, ctx.currentTime, 0.05);
}

function getActiveChain() {
  return activeChain === 'A' ? chainA : chainB;
}

function handleMessage(msg) {
  const data = JSON.parse(msg);

  if (data.action === 'warmup') {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (ctx.state === 'suspended') ctx.resume();
    // Pre-generate reverb impulse so first play is instant
    getReverbBuffer();
  }

  if (data.action === 'play') {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (ctx.state === 'suspended') ctx.resume();
    isPlaying = true;
    chainA = buildChain(currentType);
    chainA.masterGain.gain.setTargetAtTime(0.7, ctx.currentTime, 0.7);
    activeChain = 'A';
  }

  if (data.action === 'stop') {
    isPlaying = false;
    var fadeTime = 0.4;
    if (chainA) chainA.masterGain.gain.setTargetAtTime(0.0, ctx.currentTime, fadeTime / 3);
    if (chainB) chainB.masterGain.gain.setTargetAtTime(0.0, ctx.currentTime, fadeTime / 3);
    var a = chainA, b = chainB;
    chainA = null;
    chainB = null;
    setTimeout(function() {
      destroyChain(a);
      destroyChain(b);
    }, fadeTime * 1000 + 300);
  }

  if (data.action === 'crossfade') {
    currentType = data.type;
    if (!isPlaying) return;

    const fadeDuration = ${CROSSFADE_MS / 1000};
    const oldChain = getActiveChain();

    const newChain = buildChain(data.type);

    newChain.masterGain.gain.setTargetAtTime(0.7, ctx.currentTime, fadeDuration / 3);
    if (oldChain) {
      oldChain.masterGain.gain.setTargetAtTime(0.0, ctx.currentTime, fadeDuration / 3);
      setTimeout(function() { destroyChain(oldChain); }, fadeDuration * 1000 + 500);
    }

    if (activeChain === 'A') {
      chainB = newChain;
      activeChain = 'B';
    } else {
      chainA = newChain;
      activeChain = 'A';
    }
  }

  if (data.action === 'filter') {
    currentFilterVal = data.value;
    applyFilterToChain(chainA, data.value);
    applyFilterToChain(chainB, data.value);
  }

  if (data.action === 'reverb') {
    currentReverbVal = data.value;
    applyReverbToChain(chainA, data.value);
    applyReverbToChain(chainB, data.value);
  }
}

document.addEventListener('message', function(e) { handleMessage(e.data); });
window.addEventListener('message', function(e) { handleMessage(e.data); });
</script></body></html>
`;

// ─── Main App ──────────────────────────────────────────────────────
export default function App() {
  const webRef = useRef<WebView>(null);
  const [noiseType, setNoiseType] = useState<NoiseType>("white");
  const [isPlaying, setIsPlaying] = useState(false);
  const [filterVal, setFilterVal] = useState(1.0);
  const [reverbVal, setReverbVal] = useState(0.0);
  const [tutorialStep, setTutorialStep] = useState<TutorialStep>("done");
  const [tutorialVisible, setTutorialVisible] = useState(false);

  // Silent audio track to keep audio session alive in background
  const silentSound = useRef<Audio.Sound | null>(null);

  // Background
  const bgG = useRef(new Animated.Value(NOISE_COLORS.white[1])).current;
  const bgAnimRef = useRef<Animated.CompositeAnimation | null>(null);

  // Tutorial overlay fade
  const tutorialOverlay = useRef(new Animated.Value(1)).current;


  // Refs
  const filterRef = useRef(1.0);
  const reverbRef = useRef(0.0);
  const playingRef = useRef(false);
  const noiseTypeRef = useRef<NoiseType>("white");
  const isDragging = useRef(false);
  const startFilter = useRef(1.0);
  const startReverb = useRef(0.0);
  const singleTapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tutorialStepRef = useRef<TutorialStep>("done");
  const warmedUp = useRef(false);

  // Show tutorial only on first launch
  useEffect(() => {
    AsyncStorage.getItem("tutorialDone").then((val) => {
      if (!val) {
        tutorialStepRef.current = "tap";
        setTutorialStep("tap");
        setTutorialVisible(true);
      }
    });
  }, []);

  // Audio session + preload silent track + restore saved state
  useEffect(() => {
    Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
    });

    // Preload silent keepalive track
    Audio.Sound.createAsync(
      require("./assets/silence.wav"),
      { isLooping: true, volume: 0 }
    ).then(({ sound }) => {
      silentSound.current = sound;
    });

    // Restore last session's settings
    AsyncStorage.multiGet(["noiseType", "filterVal", "reverbVal"]).then((entries) => {
      const saved = Object.fromEntries(entries);
      if (saved.noiseType) {
        const nt = saved.noiseType as NoiseType;
        setNoiseType(nt);
        noiseTypeRef.current = nt;
        bgG.setValue(NOISE_COLORS[nt][1]);
      }
      if (saved.filterVal) {
        const f = parseFloat(saved.filterVal);
        setFilterVal(f);
        filterRef.current = f;
      }
      if (saved.reverbVal) {
        const r = parseFloat(saved.reverbVal);
        setReverbVal(r);
        reverbRef.current = r;
      }
    });
  }, []);

  // Save state when app goes to background
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background" || state === "inactive") {
        AsyncStorage.multiSet([
          ["noiseType", noiseTypeRef.current],
          ["filterVal", filterRef.current.toString()],
          ["reverbVal", reverbRef.current.toString()],
        ]);
      }
    });
    return () => sub.remove();
  }, []);

  const lastShake = useRef(0);

  const { orbA, orbB, textAOpacity, textBOpacity, stepA, stepB } = useTutorialAnimations(tutorialStep);

  const send = (msg: object) => {
    webRef.current?.postMessage(JSON.stringify(msg));
  };

  const updateFilter = (v: number) => {
    filterRef.current = v;
    setFilterVal(v);
  };

  const updateReverb = (v: number) => {
    reverbRef.current = v;
    setReverbVal(v);
  };

  const advanceTutorial = useCallback((from: TutorialStep) => {
    const order: TutorialStep[] = ["tap", "doubleTap", "dragV", "dragH", "done"];
    const idx = order.indexOf(from);
    if (idx < order.length - 1) {
      const next = order[idx + 1];
      tutorialStepRef.current = next;
      if (next === "done") {
        Animated.timing(tutorialOverlay, {
          toValue: 0,
          duration: 3500,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }).start(() => {
          setTutorialVisible(false);
          AsyncStorage.setItem("tutorialDone", "1");
        });
      }
      setTutorialStep(next);
    }
  }, []);

  const updatePlaying = (next: boolean) => {
    playingRef.current = next;
    setIsPlaying(next);

    // Silent track keeps iOS audio session alive in background
    if (silentSound.current) {
      if (next) {
        silentSound.current.playAsync();
      } else {
        silentSound.current.stopAsync();
      }
    }
  };

  const animateBgTo = (type: NoiseType) => {
    const [, g] = NOISE_COLORS[type];
    if (bgAnimRef.current) bgAnimRef.current.stop();
    bgAnimRef.current = Animated.timing(bgG, {
      toValue: g,
      duration: CROSSFADE_MS,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: false,
    });
    bgAnimRef.current.start(() => { bgAnimRef.current = null; });
  };

  const crossfadeToNoise = (next: NoiseType) => {
    noiseTypeRef.current = next;
    setNoiseType(next);
    animateBgTo(next);
    send({ action: "crossfade", type: next });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  // Shake to randomize
  useEffect(() => {
    Accelerometer.setUpdateInterval(150);
    const sub = Accelerometer.addListener(({ x, y, z }) => {
      const mag = Math.sqrt(x * x + y * y + z * z);
      const now = Date.now();
      if (mag > 2.5 && now - lastShake.current > 1500) {
        lastShake.current = now;
        const others = NOISE_ORDER.filter((t) => t !== noiseTypeRef.current);
        const randType = others[Math.floor(Math.random() * others.length)];
        const randFilter = 0.2 + Math.random() * 0.8;
        const randReverb = Math.random() * 0.8;

        crossfadeToNoise(randType);
        updateFilter(randFilter);
        updateReverb(randReverb);
        send({ action: "filter", value: randFilter });
        send({ action: "reverb", value: randReverb });

        if (!playingRef.current) {
          updatePlaying(true);
          send({ action: "play" });
        }

        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    });
    return () => sub.remove();
  }, []);

  const handleTap = () => {
    if (singleTapTimer.current) {
      clearTimeout(singleTapTimer.current);
      singleTapTimer.current = null;
      // Double tap
      const idx = NOISE_ORDER.indexOf(noiseTypeRef.current);
      const next = NOISE_ORDER[(idx + 1) % NOISE_ORDER.length];
      crossfadeToNoise(next);
      if (tutorialStepRef.current === "doubleTap") {
        advanceTutorial("doubleTap");
      }
    } else {
      singleTapTimer.current = setTimeout(() => {
        singleTapTimer.current = null;
        const next = !playingRef.current;
        updatePlaying(next);
        send({ action: next ? "play" : "stop" });
        if (next) {
          // Sync restored state to the new audio chain
          if (noiseTypeRef.current !== "white") {
            send({ action: "crossfade", type: noiseTypeRef.current });
          }
          send({ action: "filter", value: filterRef.current });
          send({ action: "reverb", value: reverbRef.current });
        }
        if (tutorialStepRef.current === "tap" && next) {
          advanceTutorial("tap");
        }
      }, 300);
    }
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gs) =>
        Math.abs(gs.dx) > 5 || Math.abs(gs.dy) > 5,
      onPanResponderGrant: () => {
        isDragging.current = false;
        startFilter.current = filterRef.current;
        startReverb.current = reverbRef.current;
        // Warm up audio context on first touch so play is instant
        if (!warmedUp.current) {
          warmedUp.current = true;
          webRef.current?.postMessage(JSON.stringify({ action: "warmup" }));
        }
      },
      onPanResponderMove: (_, gs) => {
        if (Math.abs(gs.dy) > 10 || Math.abs(gs.dx) > 10) {
          isDragging.current = true;
        }
        if (!playingRef.current || !isDragging.current) return;

        const dyNorm = -gs.dy / (SCREEN_H * 0.6);
        const newFilter = Math.max(0, Math.min(1, startFilter.current + dyNorm));
        updateFilter(newFilter);
        send({ action: "filter", value: newFilter });

        // Tutorial: advance after meaningful vertical drag
        if (
          tutorialStepRef.current === "dragV" &&
          Math.abs(gs.dy) > 60
        ) {
          advanceTutorial("dragV");
        }

        const dxNorm = gs.dx / (SCREEN_W * 0.8);
        const newReverb = Math.max(0, Math.min(1, startReverb.current + dxNorm));
        updateReverb(newReverb);
        send({ action: "reverb", value: newReverb });

        // Tutorial: advance after meaningful horizontal drag
        if (
          tutorialStepRef.current === "dragH" &&
          Math.abs(gs.dx) > 60
        ) {
          advanceTutorial("dragH");
        }
      },
      onPanResponderRelease: () => {
        if (!isDragging.current) {
          handleTap();
        }
        isDragging.current = false;
      },
    })
  ).current;

  const bgColor = bgG.interpolate({
    inputRange: [105, 198, 245],
    outputRange: ["rgb(139,105,20)", "rgb(245,198,208)", "rgb(245,245,245)"],
  });
  const overlayOpacity = (1 - filterVal) * 0.7;

  return (
    <View style={styles.container} {...panResponder.panHandlers}>
      <StatusBar style={noiseType === "brown" || filterVal < 0.4 ? "light" : "dark"} />

      {/* Background */}
      <Animated.View style={[styles.bgLayer, { backgroundColor: bgColor }]} />

      {/* Filter darkening */}
      <View
        style={[styles.bgLayer, { backgroundColor: "#000", opacity: overlayOpacity }]}
        pointerEvents="none"
      />

      {/* Audio engine */}
      <WebView
        ref={webRef}
        source={{ html: AUDIO_HTML }}
        style={styles.hidden}
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback={true}
      />

      {/* Tutorial orb + text overlay (A/B crossfade layers) */}
      {tutorialVisible && (
        <Animated.View
          style={[styles.bgLayer, { opacity: tutorialOverlay }]}
          pointerEvents="none"
        >
          {/* Layer A */}
          <Orb opacity={orbA.opacity} scale={orbA.scale} x={orbA.x} y={orbA.y} noiseType={noiseType} />
          <Animated.View style={[styles.tutorialTextWrap, { opacity: textAOpacity }]}>
            <Text style={[styles.tutorialText, { color: TUTORIAL_TEXT_COLORS[noiseType] }]}>
              {TUTORIAL_HINTS[stepA as Exclude<TutorialStep, "done">] ?? ""}
            </Text>
          </Animated.View>

          {/* Layer B */}
          <Orb opacity={orbB.opacity} scale={orbB.scale} x={orbB.x} y={orbB.y} noiseType={noiseType} />
          <Animated.View style={[styles.tutorialTextWrap, { opacity: textBOpacity }]}>
            <Text style={[styles.tutorialText, { color: TUTORIAL_TEXT_COLORS[noiseType] }]}>
              {TUTORIAL_HINTS[stepB as Exclude<TutorialStep, "done">] ?? ""}
            </Text>
          </Animated.View>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  bgLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  tutorialTextWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: SCREEN_H * 0.28,
    alignItems: "center",
  },
  tutorialText: {
    fontSize: 17,
    fontWeight: "300",
    letterSpacing: 0.3,
    lineHeight: 24,
    textAlign: "center",
  },
  hidden: {
    width: 0,
    height: 0,
    position: "absolute",
    top: -100,
  },
});
