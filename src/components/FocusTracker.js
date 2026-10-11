import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import * as WebGazerModule from "webgazer";

const WebGazer = WebGazerModule?.default ?? WebGazerModule ?? null;

const FocusTracker = () => {
  const statusBoxRef = useRef(null);
  const contentBoxRef = useRef(null);
  const videoRef = useRef(null);
  const webgazerInitialized = useRef(false);

  // Spacebar pause/play handler (global while component mounted) + quick cal keys
  useEffect(() => {
    const onKey = (e) => {
      if (e.code === 'Space' && videoRef.current) {
        e.preventDefault();
        if (videoRef.current.paused) videoRef.current.play().catch(() => {});
        else videoRef.current.pause();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const [status, setStatus] = useState("Initializing...");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  
  const smoothedGaze = useRef({ x: 0, y: 0 });
  const focusConfidence = useRef(0);

  const gazeHistory = useRef([]);
  const focusStart = useRef(Date.now());
  const outsideStart = useRef(null);
  const lastGazeTime = useRef(Date.now());
  const animationFrameId = useRef(null);
  const isCalibrated = useRef(false);
  const calibrationMatrix = useRef(null); // {a,b,c,d,e,f}

  const MAX_HISTORY = 25;
  const DISTRACT_TIME = 1000;
  const GAZE_TIMEOUT = 3000;
  const THROTTLE_DELAY = 50;
  const SMOOTHING_FACTOR = 0.3;

  const getContentBounds = useCallback(() => {
    if (!contentBoxRef.current) return null;
    try {
      const rect = contentBoxRef.current.getBoundingClientRect();
      // Use smaller base margins so the active area isn't too narrow
      const baseMarginX = rect.width * 0.04;
      const baseMarginY = rect.height * 0.04;
      const confidenceMultiplier = isCalibrated.current ? 0.6 : 1.0;
      const marginX = baseMarginX * confidenceMultiplier;
      const marginY = baseMarginY * confidenceMultiplier;
      const xMin = rect.left + Math.min(marginX, rect.width * 0.45);
      const xMax = rect.right - Math.min(marginX, rect.width * 0.45);
      const yMin = rect.top + Math.min(marginY, rect.height * 0.45);
      const yMax = rect.bottom - Math.min(marginY, rect.height * 0.45);
      return {
        xMin,
        xMax,
        yMin,
        yMax,
        centerX: rect.left + rect.width / 2,
        centerY: rect.top + rect.height / 2,
        width: rect.width,
        height: rect.height
      };
    } catch (err) {
      console.warn("Error getting content bounds:", err);
      return null;
    }
  }, []);

  const clamp = useCallback((val, min, max) => {
    return val < min ? min : val > max ? max : val;
  }, []);

  const getWeightedAverage = useCallback((values) => {
    if (!values.length) return null;
    let weightedSum = 0;
    let totalWeight = 0;
    values.forEach((val, index) => {
      const weight = Math.pow(1.2, index);
      weightedSum += val * weight;
      totalWeight += weight;
    });
    return weightedSum / totalWeight;
  }, []);

  const smoothGaze = useCallback((newX, newY) => {
    smoothedGaze.current.x = smoothedGaze.current.x * (1 - SMOOTHING_FACTOR) + newX * SMOOTHING_FACTOR;
    smoothedGaze.current.y = smoothedGaze.current.y * (1 - SMOOTHING_FACTOR) + newY * SMOOTHING_FACTOR;
    return smoothedGaze.current;
  }, []);

  // Apply calibration affine transform if available
  const applyCalibration = useCallback((x, y) => {
    const m = calibrationMatrix.current;
    if (!m) return { x, y };
    return {
      x: m.a * x + m.b * y + m.c,
      y: m.d * x + m.e * y + m.f
    };
  }, []);

  const showAlert = useCallback(() => {
    const existingAlert = document.getElementById("alertBox");
    if (existingAlert) return;
    try {
      const alertDiv = document.createElement("div");
      alertDiv.id = "alertBox";
      Object.assign(alertDiv.style, {
        position: "fixed",
        top: "10px",
        left: "50%",
        transform: "translateX(-50%)",
        background: "#E74C3C",
        color: "white",
        padding: "10px 20px",
        borderRadius: "8px",
        fontWeight: "bold",
        zIndex: "10000",
        animation: "fadeIn 0.3s ease"
      });
      alertDiv.textContent = "👀 Look at the screen!";
      document.body.appendChild(alertDiv);
      setTimeout(() => {
        if (alertDiv && alertDiv.parentNode) {
          alertDiv.parentNode.removeChild(alertDiv);
        }
      }, 2000);
    } catch (err) {
      console.warn("Error showing alert:", err);
    }
  }, []);

  const lastProcessTime = useRef(0);
  const processGazeData = useCallback((data, elapsedTime) => {
    if (!data) return;
    const now = Date.now();
    if (now - lastProcessTime.current < THROTTLE_DELAY) return;
    lastProcessTime.current = now;

    lastGazeTime.current = now;
    // Some webgazer builds provide pixel coords, others normalized (0..1), others page coords.
    let rawX = data.x ?? data.pageX ?? data.screenX ?? data.xCoord ?? null;
    let rawY = data.y ?? data.pageY ?? data.screenY ?? data.yCoord ?? null;
    if (rawX === null || rawY === null) return;

    let clientX = rawX;
    let clientY = rawY;

    // Normalized (0..1)
    if (rawX >= 0 && rawX <= 1 && rawY >= 0 && rawY <= 1) {
      clientX = rawX * window.innerWidth;
      clientY = rawY * window.innerHeight;
    } else if (rawX > window.innerWidth || rawY > window.innerHeight) {
      // If values exceed viewport size, assume page/document coords and convert to client coords
      clientX = rawX - (window.scrollX || document.documentElement.scrollLeft || 0);
      clientY = rawY - (window.scrollY || document.documentElement.scrollTop || 0);
    }

    const clampedX = clamp(clientX, 0, window.innerWidth);
    const clampedY = clamp(clientY, 0, window.innerHeight);
    let smoothed = smoothGaze(clampedX, clampedY);
    // Apply calibration correction if present
    const calibrated = applyCalibration(smoothed.x, smoothed.y);
    smoothed = { x: calibrated.x, y: calibrated.y };
    // Normalized percentages across the viewport (0..1)
    const pctX = clamp(smoothed.x / Math.max(1, window.innerWidth), 0, 1);
    const pctY = clamp(smoothed.y / Math.max(1, window.innerHeight), 0, 1);
    gazeHistory.current.push({ x: smoothed.x, y: smoothed.y, pctX, pctY, timestamp: now });
    if (gazeHistory.current.length > MAX_HISTORY) gazeHistory.current.shift();
    if (gazeHistory.current.length < 5) return;

  const recentGazes = gazeHistory.current.slice(-10);
  const avgX = getWeightedAverage(recentGazes.map(p => p.x));
  const avgY = getWeightedAverage(recentGazes.map(p => p.y));
  const avgPctX = getWeightedAverage(recentGazes.map(p => p.pctX));
  const avgPctY = getWeightedAverage(recentGazes.map(p => p.pctY));
  if (avgX === null || avgY === null || avgPctX === null || avgPctY === null) return;

  const bounds = getContentBounds();
    if (!bounds) return;

    // Optional debug logging if enabled by setting window.__GAZE_DEBUG = true in console
    try { if (window.__GAZE_DEBUG) console.debug('gaze', { rawX, rawY, smoothed, pctX, pctY, avgPctX, avgPctY, bounds }); } catch (e) {}

    // Convert content bounds to viewport percentages so checks are resolution-independent
    const contentPctXMin = clamp(bounds.xMin / Math.max(1, window.innerWidth), 0, 1);
    const contentPctXMax = clamp(bounds.xMax / Math.max(1, window.innerWidth), 0, 1);
    const contentPctYMin = clamp(bounds.yMin / Math.max(1, window.innerHeight), 0, 1);
    const contentPctYMax = clamp(bounds.yMax / Math.max(1, window.innerHeight), 0, 1);

    // Hysteresis margin to avoid flicker near edges
    const edgeMargin = 0.03; // 3% margin
    const inX = avgPctX >= (contentPctXMin + edgeMargin) && avgPctX <= (contentPctXMax - edgeMargin);
    const inY = avgPctY >= (contentPctYMin + edgeMargin) && avgPctY <= (contentPctYMax - edgeMargin);
    const isInBounds = inX && inY;

    // Update confidence
    if (isInBounds) {
      focusConfidence.current = Math.min(1, focusConfidence.current + 0.12);
      outsideStart.current = null; // reset outside timer
    } else {
      focusConfidence.current = Math.max(0, focusConfidence.current - 0.06);
      // start outside timer if not already started
      if (!outsideStart.current) outsideStart.current = now;
    }

    const isFocused = focusConfidence.current > 0.35;

    // If gaze is focused inside bounds, ensure video plays
    if (isInBounds || isFocused) {
      setStatus("Focused ✅");
      focusStart.current = now;
      if (videoRef.current?.paused) videoRef.current.play().catch(err => console.warn("Could not play video:", err));
    }

    // If gaze has been outside the content area for longer than DISTRACT_TIME, pause
    if (outsideStart.current && (now - outsideStart.current) > DISTRACT_TIME) {
      setStatus("Distracted ❌");
      if (videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause();
        showAlert();
      }
    }
  }, [applyCalibration, getContentBounds, clamp, getWeightedAverage, smoothGaze, showAlert]);

  const checkGazeTimeout = useCallback(() => {
    const now = Date.now();
    if (now - lastGazeTime.current > GAZE_TIMEOUT) {
      setStatus("No Eye Tracking ⚠");
      if (videoRef.current && !videoRef.current.paused) videoRef.current.pause();
    }
    animationFrameId.current = requestAnimationFrame(checkGazeTimeout);
  }, []);

  const initializeWebGazer = useCallback(async () => {
    if (webgazerInitialized.current) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const webgazerApi = WebGazer?.default ?? WebGazer ?? null;
    if (!webgazerApi || typeof webgazerApi.begin !== 'function') {
      setStatus("Eye tracking unavailable in this browser");
      setIsLoading(false);
      return;
    }

    try {
      window.webgazer = webgazerApi;
      setStatus("Requesting camera access...");
      if (navigator.mediaDevices?.getUserMedia) {
        await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
      }
      setStatus("Initializing eye tracking...");
      // Configure WebGazer safely. Some builds may not support all methods.
      let webgazer = webgazerApi;
      try {
        if (typeof webgazer.setRegression === 'function') webgazer = webgazer.setRegression('ridge');
      } catch (err) { console.warn('setRegression failed', err); }
      try {
        if (typeof webgazer.setTracker === 'function') {
          try { webgazer = webgazer.setTracker('TFFacemesh'); } catch (err) { console.warn('setTracker TFFacemesh failed, falling back', err); }
        }
      } catch (err) { console.warn('setTracker failed', err); }
      try { if (typeof webgazer.saveDataAcrossSessions === 'function') webgazer = webgazer.saveDataAcrossSessions(true); } catch (err) { console.warn('saveDataAcrossSessions failed', err); }
      try {
        if (window.webgazer.params) {
          window.webgazer.params.showVideo = true;
          window.webgazer.params.showFaceOverlay = false;
          window.webgazer.params.showFaceFeedbackBox = false;
          window.webgazer.params.showGazeDot = false; // we'll draw our own debug dot
        }
      } catch (err) { console.warn('Could not set webgazer.params', err); }

      if (typeof webgazer.begin !== 'function') {
        throw new Error("WebGazer begin() is unavailable in this environment.");
      }

      await webgazer.begin();
      await new Promise(resolve => setTimeout(resolve, 1000));
      let attempts = 0;
      while (attempts < 15) {
        if (window.webgazer.isReady && window.webgazer.isReady()) break;
        await new Promise(resolve => setTimeout(resolve, 300));
        attempts++;
      }
      if (attempts >= 15) throw new Error("WebGazer initialization timeout.");
      // Set gaze listener and show video preview. Keep prediction points off by default.
      window.webgazer.setGazeListener(processGazeData);
      try { window.webgazer.showVideoPreview(true); } catch (err) { console.warn('showVideoPreview failed', err); }
      try { window.webgazer.showPredictionPoints(false); } catch (err) { /* ignore */ }

      // No on-screen debug dot created in production build (keeps UI clean)
      webgazerInitialized.current = true;
      setIsLoading(false);
      setStatus("Please look at different parts of the screen to calibrate");
      checkGazeTimeout();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown WebGazer error';
      console.error("WebGazer initialization failed:", err);
      setError(`Failed to initialize eye tracking: ${message}`);
      setIsLoading(false);
      webgazerInitialized.current = false;
    }
  }, [processGazeData, checkGazeTimeout]);

  const loadWebGazer = useCallback(() => {
    initializeWebGazer();
  }, [initializeWebGazer]);

  const cleanup = useCallback(() => {
    try {
      if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
      if (window.webgazer && webgazerInitialized.current) {
        window.webgazer.clearGazeListener(); window.webgazer.end();
      }
      const alertBox = document.getElementById("alertBox");
      if (alertBox && alertBox.parentNode) alertBox.parentNode.removeChild(alertBox);
      webgazerInitialized.current = false;
      gazeHistory.current = [];
    } catch {}
  }, []);

  useEffect(() => { loadWebGazer(); return () => cleanup(); }, [cleanup, loadWebGazer]);

  const handleVideoError = useCallback((e) => { console.warn("Video error:", e); setError("Video failed to load."); }, []);

  const statusStyle = useMemo(() => ({
    fontSize: "1.8em",
    fontWeight: "bold",
    padding: "15px",
    borderRadius: "10px",
    marginTop: "20px",
    display: "inline-block",
    color: "white",
    transition: "all 0.3s ease",
    background: status.includes("Focused") ? "#2ECC71" : status.includes("Distracted") ? "#E74C3C" : status.includes("No Eye") ? "#F39C12" : "#95A5A6"
  }), [status]);

  if (error) {
    return (
      <div style={{ textAlign: "center", marginTop: "50px", color: "#E74C3C" }}>
        <h2>Error</h2>
        <p>{error}</p>
        <button onClick={() => window.location.reload()} style={{ padding: "10px 20px", background: "#3498DB", color: "white", border: "none", borderRadius: "5px", cursor: "pointer" }}>Refresh Page</button>
      </div>
    );
  }

  return (
    <div style={{ textAlign: "center", marginTop: "30px", fontFamily: "Arial, sans-serif" }}>
      <h1>Smart Attention Tracker</h1>
      <p>{isLoading ? "Loading eye tracking..." : "Focus on the video below. Eye tracking will pause/play automatically."}</p>
      <div ref={contentBoxRef} style={{ width: "70%", maxWidth: "800px", height: "400px", margin: "20px auto", border: "3px solid #333", borderRadius: "10px", position: "relative", display: "flex", justifyContent: "center", alignItems: "center", background: "#000" }}>
        <video ref={videoRef} width="100%" height="100%" controls preload="metadata" onError={handleVideoError} style={{ borderRadius: "7px" }}>
          <source src="https://media.w3.org/2010/05/sintel/trailer_hd.mp4" type="video/mp4" />
          Your browser does not support video playback.
        </video>
      </div>
      {/* Calibrate button removed per user request */}
      <div ref={statusBoxRef} style={statusStyle}>{status}</div>
    </div>
  );
};

export default FocusTracker;