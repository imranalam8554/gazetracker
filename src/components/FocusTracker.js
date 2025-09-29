import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";

const FocusTracker = () => {
  const statusBoxRef = useRef(null);
  const contentBoxRef = useRef(null);
  const videoRef = useRef(null);
  const webgazerInitialized = useRef(false);
  const cleanupFunctions = useRef([]);

  const [status, setStatus] = useState("Initializing...");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  
  const smoothedGaze = useRef({ x: 0, y: 0 });
  const focusConfidence = useRef(0);

  const gazeHistory = useRef([]);
  const focusStart = useRef(Date.now());
  const lastGazeTime = useRef(Date.now());
  const animationFrameId = useRef(null);
  const isCalibrated = useRef(false);

  const MAX_HISTORY = 25;
  const DISTRACT_TIME = 1000;
  const GAZE_TIMEOUT = 3000;
  const THROTTLE_DELAY = 50;
  const SMOOTHING_FACTOR = 0.3;

  const getContentBounds = useCallback(() => {
    if (!contentBoxRef.current) return null;
    try {
      const rect = contentBoxRef.current.getBoundingClientRect();
      const baseMarginX = rect.width * 0.08;
      const baseMarginY = rect.height * 0.08;
      const confidenceMultiplier = isCalibrated.current ? 0.7 : 1.2;
      const marginX = baseMarginX * confidenceMultiplier;
      const marginY = baseMarginY * confidenceMultiplier;
      return {
        xMin: rect.left + marginX,
        xMax: rect.right - marginX,
        yMin: rect.top + marginY,
        yMax: rect.bottom - marginY,
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
    if (!data || !data.x || !data.y || isNaN(data.x) || isNaN(data.y)) return;
    const now = Date.now();
    if (now - lastProcessTime.current < THROTTLE_DELAY) return;
    lastProcessTime.current = now;

    lastGazeTime.current = now;
    const clampedX = clamp(data.x, 0, window.innerWidth);
    const clampedY = clamp(data.y, 0, window.innerHeight);
    const smoothed = smoothGaze(clampedX, clampedY);
    gazeHistory.current.push({ x: smoothed.x, y: smoothed.y, timestamp: now });
    if (gazeHistory.current.length > MAX_HISTORY) gazeHistory.current.shift();
    if (gazeHistory.current.length < 5) return;

    const recentGazes = gazeHistory.current.slice(-10);
    const avgX = getWeightedAverage(recentGazes.map(p => p.x));
    const avgY = getWeightedAverage(recentGazes.map(p => p.y));
    if (avgX === null || avgY === null) return;

    const bounds = getContentBounds();
    if (!bounds) return;

    const isInBounds = avgX >= bounds.xMin && avgX <= bounds.xMax && avgY >= bounds.yMin && avgY <= bounds.yMax;

    if (isInBounds) focusConfidence.current = Math.min(1, focusConfidence.current + 0.1);
    else focusConfidence.current = Math.max(0, focusConfidence.current - 0.05);

    const isFocused = focusConfidence.current > 0.3;

    if (isFocused) {
  setStatus("Focused ✅");
      focusStart.current = now;
      if (videoRef.current?.paused) videoRef.current.play().catch(err => console.warn("Could not play video:", err));
    } else if (now - focusStart.current > DISTRACT_TIME) {
  setStatus("Distracted ❌");
      if (videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause();
        showAlert();
      }
    }
  }, [getContentBounds, clamp, getWeightedAverage, smoothGaze, showAlert]);

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
    try {
      if (!window.webgazer) throw new Error("WebGazer not loaded");
      setStatus("Requesting camera access...");
      if (navigator.mediaDevices?.getUserMedia) {
        await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
      }
      setStatus("Initializing eye tracking...");
      const webgazer = window.webgazer.setRegression("ridge").setTracker("TFFacemesh").saveDataAcrossSessions(true);
      if (window.webgazer.params) {
        window.webgazer.params.showVideo = true;
        window.webgazer.params.showFaceOverlay = false;
        window.webgazer.params.showFaceFeedbackBox = false;
        window.webgazer.params.showGazeDot = false;
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
      window.webgazer.setGazeListener(processGazeData);
      window.webgazer.showVideoPreview(true);
      window.webgazer.showPredictionPoints(false);
      webgazerInitialized.current = true;
      setIsLoading(false);
      setStatus("Please look at different parts of the screen to calibrate");
      checkGazeTimeout();
    } catch (err) {
      console.error("WebGazer initialization failed:", err);
  setError(`Failed to initialize eye tracking: ${err.message}`);
      setIsLoading(false);
      webgazerInitialized.current = false;
    }
  }, [processGazeData, checkGazeTimeout]);

  const loadWebGazer = useCallback(() => {
    if (window.webgazer) { initializeWebGazer(); return; }
    const script = document.createElement("script");
    script.src = "https://webgazer.cs.brown.edu/webgazer.js";
    script.async = true;
    script.onload = () => initializeWebGazer();
    script.onerror = () => { setError("Failed to load eye tracking library."); setIsLoading(false); };
    document.head.appendChild(script);
    cleanupFunctions.current.push(() => { if (script && script.parentNode) script.parentNode.removeChild(script); });
  }, [initializeWebGazer]);

  const cleanup = useCallback(() => {
    try {
      if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
      if (window.webgazer && webgazerInitialized.current) {
        window.webgazer.clearGazeListener(); window.webgazer.end();
      }
      cleanupFunctions.current.forEach(fn => { try { fn(); } catch {} });
      const alertBox = document.getElementById("alertBox");
      if (alertBox && alertBox.parentNode) alertBox.parentNode.removeChild(alertBox);
      webgazerInitialized.current = false;
      gazeHistory.current = [];
    } catch {}
  }, []);

  useEffect(() => { loadWebGazer(); return () => cleanup(); }, []);

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
      <div ref={statusBoxRef} style={statusStyle}>{status}</div>
    </div>
  );
};

export default FocusTracker;