const $ = id => document.getElementById(id);
let active = false, watchId = null, buffer = [], total = 0, latestSpeed = null;
let lastSent = 0, wakeLock = null;
let labelHistory = [];
let lastAutoUpload = 0;
const DATA_KEY = "smartDriverTrainingRowsV1";
let trainingRows = loadTrainingRows();

function fmt(v){ return Number.isFinite(v) ? v.toFixed(2) : "--"; }
function log(message){
  const list = $("events");
  if(!list) return;
  const empty = list.querySelector(".empty"); if(empty) empty.remove();
  const li = document.createElement("li");
  li.textContent = `${new Date().toLocaleTimeString()} — ${message}`;
  list.prepend(li);
  while(list.children.length > 12) list.lastChild.remove();
}
function setStatus(text, live){
  $("status").textContent = text;
  $("dot").classList.toggle("live", !!live);
}
function loadTrainingRows(){
  try {
    const saved = JSON.parse(localStorage.getItem(DATA_KEY) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch(e) { return []; }
}
function persistTrainingRows(){
  try {
    localStorage.setItem(DATA_KEY, JSON.stringify(trainingRows));
    updateCollectorCount();
  } catch(e) {
    $("collectorMessage").textContent = "Browser storage is full. Export your CSV, then clear saved rows.";
  }
}
function updateCollectorCount(){
  const count = $("trainingCount");
  if(count) count.textContent = trainingRows.length;
}
function addCollectorUI(){
  if($("trainingCollector")) return;
  const panel = document.createElement("section");
  panel.id = "trainingCollector";
  panel.style.cssText = "margin:18px 0;padding:16px;border:1px solid #64748b55;border-radius:14px;background:#64748b0d;color:inherit;";
  panel.innerHTML = `
    <h3 style="margin:0 0 8px">Automatic driving-data collection</h3>
    <p style="margin:0 0 12px;font-size:14px;opacity:.8">Enter your participant details once, give consent, then press Start Monitoring. The page uploads a short feature summary about every 10 seconds while it remains open.</p>
    <label for="participantId" style="display:block;margin:8px 0 6px;font-size:14px">Participant ID (nickname/code, not your real name)</label>
    <input id="participantId" maxlength="24" placeholder="e.g. driver_01" style="width:100%;max-width:360px;padding:10px;border-radius:8px;margin-bottom:8px">
    <label for="collectorCode" style="display:block;margin:4px 0 6px;font-size:14px">Shared collection access code</label>
    <input id="collectorCode" type="password" autocomplete="off" placeholder="Provided by project owner" style="width:100%;max-width:360px;padding:10px;border-radius:8px;margin-bottom:8px">
    <label style="display:block;margin:4px 0 12px;font-size:13px"><input id="dataConsent" type="checkbox"> I agree to share periodic sensor-feature summaries for this academic project. Raw GPS coordinates and raw sensor streams are not uploaded.</label>
    <p style="margin:10px 0 4px;font-size:14px">Shared windows received: <strong id="serverTrainingCount">--</strong></p>
    <p id="collectorMessage" role="status" style="margin:0;font-size:13px;opacity:.85">After entering the details and ticking consent, press Start Monitoring above. Keep this page open during the trip.</p>
  `;
  const anchor = $("events")?.parentElement || $("result")?.parentElement || document.body;
  anchor.insertAdjacentElement("afterend", panel);
  refreshServerTrainingCount();
}
function magnitudeStats(rows, keys){
  const magnitudes = rows.map(s => Math.sqrt(keys.reduce((sum, key) => sum + (Number(s[key]) || 0) ** 2, 0)));
  const mean = magnitudes.reduce((a,b) => a+b, 0) / magnitudes.length;
  const variance = magnitudes.reduce((sum,v) => sum + (v-mean)**2, 0) / magnitudes.length;
  return {mean, std:Math.sqrt(variance), max:Math.max(...magnitudes)};
}
function featuresFor(rows){
  const a = magnitudeStats(rows, ["ax","ay","az"]);
  const g = magnitudeStats(rows, ["gx","gy","gz"]);
  const speeds = rows.map(s => s.speed_kmh).filter(v => v !== null && Number.isFinite(v));
  const speedChange = speeds.length > 1 ? speeds[speeds.length - 1] - speeds[0] : 0;
  return {
    mean_accel:a.mean, std_accel:a.std, max_accel:a.max,
    mean_gyro:g.mean, std_gyro:g.std, max_gyro:g.max,
    speed_change:speedChange
  };
}
function saveTrainingWindow(){
  if(!active){
    $("collectorMessage").textContent = "Start monitoring before saving a sensor window.";
    return;
  }
  const cutoff = Date.now()/1000 - 5;
  const windowSamples = labelHistory.filter(s => s.timestamp >= cutoff);
  if(windowSamples.length < 10){
    $("collectorMessage").textContent = `Only ${windowSamples.length} recent samples available. Keep monitoring for a few more seconds.`;
    return;
  }
  const label = $("trainingLabel").value;
  const row = {...featuresFor(windowSamples), label};
  trainingRows.push(row);
  persistTrainingRows();
  $("collectorMessage").textContent = `Saved ${label} window (${windowSamples.length} sensor samples). Total: ${trainingRows.length}.`;
  log(`Training window saved: ${label}`);
}
async function refreshServerTrainingCount(){
  try {
    const response = await fetch("/api/collection/stats", {cache:"no-store"});
    if(!response.ok) return;
    const data = await response.json();
    $("serverTrainingCount").textContent = data.total_windows ?? "--";
  } catch(e) {
    $("serverTrainingCount").textContent = "offline";
  }
}
function getParticipantCredentials(){
  const participantId = $("participantId")?.value.trim() || "";
  const accessCode = $("collectorCode")?.value || "";
  const consent = $("dataConsent")?.checked || false;
  if(!/^[a-zA-Z0-9_-]{3,24}$/.test(participantId))
    throw new Error("Enter a participant ID using 3–24 letters, numbers, _ or -.");
  if(!accessCode) throw new Error("Enter the shared collection access code.");
  if(!consent) throw new Error("Please tick the consent box before monitoring.");
  return {participantId, accessCode};
}
async function autoUploadWindow(){
  if(!active || labelHistory.length < 10) return;
  const now = Date.now();
  if(now - lastAutoUpload < 10000) return;
  const cutoff = now/1000 - 10;
  const windowSamples = labelHistory.filter(s => s.timestamp >= cutoff);
  if(windowSamples.length < 10) return;
  lastAutoUpload = now;
  const features = featuresFor(windowSamples);
  try {
    const {participantId, accessCode} = getParticipantCredentials();
    const response = await fetch("/api/collection/submit", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        participant_id:participantId,
        access_code:accessCode,
        consent:true,
        features,
        window_seconds:10
      })
    });
    const data = await response.json();
    if(!response.ok) throw new Error(data.detail || "Upload failed.");
    $("collectorMessage").textContent = `Automatically uploaded a 10-second summary. Shared windows received: ${data.total_windows}.`;
    refreshServerTrainingCount();
  } catch(e) {
    $("collectorMessage").textContent = `Automatic upload paused: ${e.message}`;
  }
}
function motionHandler(event){
  if(!active) return;
  const a = event.accelerationIncludingGravity || event.acceleration || {};
  const r = event.rotationRate || {};
  const sample = {
    timestamp: Date.now()/1000,
    ax: Number(a.x)||0, ay: Number(a.y)||0, az: Number(a.z)||0,
    gx: (Number(r.alpha)||0)*Math.PI/180,
    gy: (Number(r.beta)||0)*Math.PI/180,
    gz: (Number(r.gamma)||0)*Math.PI/180,
    speed_kmh: latestSpeed
  };
  ["ax","ay","az","gx","gy","gz"].forEach(k => $(k).textContent = fmt(sample[k]));
  buffer.push(sample); total++; $("samples").textContent = total;
  labelHistory.push(sample);
  const historyCutoff = sample.timestamp - 12;
  while(labelHistory.length && labelHistory[0].timestamp < historyCutoff) labelHistory.shift();
  if(buffer.length > 30) buffer.shift();
  if(buffer.length >= 10 && Date.now()-lastSent > 5000) sendBatch();
  if(labelHistory.length >= 10) autoUploadWindow();
}
function orientationFallback(){
  // DeviceOrientation is not used as a substitute for true angular velocity.
}
function geoSuccess(position){
  const speed = position.coords.speed;
  if(speed !== null && Number.isFinite(speed)){
    latestSpeed = speed*3.6; $("speed").textContent = latestSpeed.toFixed(1);
  }
}
function geoError(err){ $("hint").textContent = "Location unavailable: " + err.message + ". Motion analysis can still run."; }

async function sendBatch(){
  if(buffer.length < 3) return;
  const batch = buffer.slice(); lastSent = Date.now();
  try{
    const response = await fetch("/api/analyse", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({samples:batch})
    });
    const data = await response.json();
    if(data.ok){
      $("result").textContent = data.classification.replaceAll("_"," ");
      $("method").textContent = data.method.replaceAll("_"," ");
      if(data.classification !== "normal_or_unclassified")
        log(`${data.classification.replaceAll("_"," ")} (${data.method})`);
    }
  }catch(e){ $("hint").textContent = "Could not reach the analysis server. Check your connection."; }
}
async function start(){
  try { getParticipantCredentials(); }
  catch(e) { $("collectorMessage").textContent = e.message; return; }
  if(!("DeviceMotionEvent" in window)){
    $("hint").textContent = "This browser does not expose motion sensors. Try a supported mobile browser.";
    return;
  }
  try{
    if(typeof DeviceMotionEvent.requestPermission === "function"){
      const permission = await DeviceMotionEvent.requestPermission();
      if(permission !== "granted") throw new Error("Motion permission was not granted.");
    }
    active = true; total = 0; buffer = []; labelHistory = []; lastSent = 0; lastAutoUpload = 0;
    window.addEventListener("devicemotion", motionHandler);
    if(navigator.geolocation){
      watchId = navigator.geolocation.watchPosition(geoSuccess, geoError,
        {enableHighAccuracy:true, maximumAge:1000, timeout:10000});
    }
    if("wakeLock" in navigator){
      try{ wakeLock = await navigator.wakeLock.request("screen"); }catch(e){}
    }
    $("start").disabled = true; $("stop").disabled = false;
    setStatus("Monitoring active", true);
    $("hint").textContent = "Collecting sensor readings. Keep the phone securely mounted and the screen awake.";
    $("collectorMessage").textContent = "Monitoring is active. Wait at least 5 seconds, then save locally or submit a labelled summary to the shared dataset.";
    log("Monitoring started");
  }catch(e){
    $("hint").textContent = e.message || "Could not start sensor monitoring.";
  }
}
async function stop(){
  active = false;
  window.removeEventListener("devicemotion", motionHandler);
  if(watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  if(wakeLock){ try{await wakeLock.release();}catch(e){} wakeLock=null; }
  await sendBatch();
  $("start").disabled = false; $("stop").disabled = true;
  setStatus("Monitoring stopped", false); log("Monitoring stopped");
  $("collectorMessage").textContent = "Monitoring stopped. Automatic uploads have paused.";
}
$("start").addEventListener("click", start);
$("stop").addEventListener("click", stop);
document.addEventListener("visibilitychange", async ()=>{
  if(active && document.visibilityState === "visible" && "wakeLock" in navigator){
    try{wakeLock = await navigator.wakeLock.request("screen");}catch(e){}
  }
});
addCollectorUI();
