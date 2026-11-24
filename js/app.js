(() => {
  const $ = id => document.getElementById(id);
  const video = $('video'), canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
  let stream = null, track = null, torchOn = false;
  let session = null, chunks = [], got = 0, count = 0, total = 0, crc = 0, done = false, blob = null, fileName = '', lastHit = 0;

  // ---------- helpers ----------
  const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = u8 => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const toast = t => { const e = $('toast'); e.textContent = t; e.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.remove('show'), 2600); };
  const setMsg = (t, cls) => { const m = $('msg'); m.textContent = t; m.className = 'msg' + (cls ? ' ' + cls : ''); };
  const step = n => ['st1', 'st2', 'st3'].forEach((id, i) => { $(id).className = 'step' + (i + 1 < n ? ' done' : i + 1 === n ? ' on' : ''); });
  const store = { get: k => { try { return localStorage.getItem('aq_' + k) || ''; } catch { return ''; } }, set: (k, v) => { try { localStorage.setItem('aq_' + k, v); } catch {} } };
  ['site', 'toMail', 'toPhone'].forEach(id => { $(id).value = store.get(id); $(id).addEventListener('change', () => store.set(id, $(id).value.trim())); });

  // ---------- camera ----------
  async function listCameras(currentId) {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    const sel = $('camSelect'); sel.innerHTML = '';
    devs.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId; o.textContent = d.label || `Camera ${i + 1}`;
      if (d.deviceId === currentId) o.selected = true;
      sel.appendChild(o);
    });
    sel.disabled = devs.length < 2;
  }
  async function startCamera(deviceId) {
    if (!navigator.mediaDevices?.getUserMedia) { setMsg('This browser cannot use the camera. Open the page in Chrome or Safari over https.', 'bad'); return; }
    stopCamera();
    const video_c = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } };
    Object.assign(video_c, { width: { ideal: 1920 }, height: { ideal: 1080 } });
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: video_c, audio: false });
    } catch (e) {
      setMsg(e.name === 'NotAllowedError' ? 'Camera permission was refused. Allow camera access for this site in the browser settings and try again.' : 'Camera could not start: ' + e.message, 'bad');
      return;
    }
    track = stream.getVideoTracks()[0];
    try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch {}
    video.srcObject = stream; await video.play();
    $('placeholder').classList.add('hidden');
    $('startBtn').classList.add('hidden'); $('camRow').classList.remove('hidden');
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    $('torchBtn').classList.toggle('hidden', !caps.torch);
    await listCameras(track.getSettings().deviceId);
    step(2); setMsg('Point at the QR code on the analyzer screen and press Start on the PC.');
    requestAnimationFrame(tick);
  }
  function stopCamera() {
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; track = null; torchOn = false;
  }
  $('startBtn').onclick = () => startCamera();
  $('camSelect').onchange = e => startCamera(e.target.value);
  $('stopBtn').onclick = () => { stopCamera(); $('camRow').classList.add('hidden'); $('startBtn').classList.remove('hidden'); $('placeholder').classList.remove('hidden'); step(1); };
  $('torchBtn').onclick = async () => { if (!track) return; torchOn = !torchOn; try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch { toast('Torch not supported on this camera'); } };

  // ---------- scanning ----------
  function tick() {
    if (!stream || done) return;
    if (video.readyState >= 2) {
      const w = video.videoWidth, h = video.videoHeight, s = Math.min(1, 1000 / Math.max(w, h));
      canvas.width = Math.round(w * s); canvas.height = Math.round(h * s);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = typeof jsQR === 'function' ? jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' }) : null;
      if (code && code.binaryData) take(Uint8Array.from(code.binaryData));
      $('reticle').classList.toggle('hit', performance.now() - lastHit < 300);
    }
    requestAnimationFrame(tick);
  }
  function resetPack() {
    session = null; chunks = []; got = 0; count = 0; total = 0; crc = 0; done = false; blob = null;
    $('grid').innerHTML = ''; $('bar').style.width = '0'; $('pct').textContent = '0%'; $('count').textContent = 'Waiting for codes…';
  }
  function take(f) {
    if (f.length < 20 || f[0] !== 65 || f[1] !== 81 || f[2] !== 1) return;          // "AQ" + format 1
    lastHit = performance.now();
    const dv = new DataView(f.buffer);
    const sid = dv.getUint32(3, true), idx = dv.getUint16(7, true), n = dv.getUint16(9, true);
    if (session !== sid) {
      resetPack(); session = sid; count = n; total = dv.getUint32(11, true); crc = dv.getUint32(15, true);
      chunks = new Array(n).fill(null);
      const g = $('grid'); for (let i = 0; i < n; i++) g.appendChild(document.createElement('i'));
      setMsg('Receiving… keep the phone steady.');
    }
    if (idx >= count || chunks[idx]) return;
    chunks[idx] = f.slice(19); got++;
    $('grid').children[idx].className = 'got';
    const p = Math.floor(got * 100 / count);
    $('bar').style.width = p + '%'; $('pct').textContent = p + '%'; $('count').textContent = `${got} of ${count} codes`;
    if (got === count) finish();
    else if (got > count * 0.9) setMsg('Almost done – the missing codes come round again on the PC.', 'warn');
  }
  function finish() {
    const out = new Uint8Array(total); let off = 0;
    for (const c of chunks) { out.set(c.subarray(0, Math.min(c.length, total - off)), off); off += c.length; }
    if (off < total || crc32(out) !== crc) {
      setMsg('Check failed – some codes were misread. Scanning again…', 'bad');
      chunks = chunks.map(() => null); got = 0; for (const i of $('grid').children) i.className = ''; return;
    }
    done = true; stopCamera(); navigator.vibrate && navigator.vibrate([60, 40, 60]);
    const d = new Date(), z = x => String(x).padStart(2, '0');
    fileName = `AQ200EXCLUS_Service_${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}.zip`;
    blob = new Blob([out], { type: 'application/zip' });
    $('fileTitle').textContent = fileName;
    $('fileInfo').textContent = `${(total / 1024).toFixed(0)} KB · ${count} codes · integrity check passed`;
    $('scanCard').classList.add('hidden'); $('doneArea').classList.remove('hidden'); step(3);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------- sharing ----------
  const subject = () => `AQ200 EXCLUS service pack${$('site').value ? ' – ' + $('site').value : ''}`;
  const body = () => [
    'AQ200 EXCLUS service pack',
    $('site').value && 'Site: ' + $('site').value,
    $('note').value && 'Problem: ' + $('note').value,
    'File: ' + fileName + ' (' + (total / 1024).toFixed(0) + ' KB)',
    'Sent: ' + new Date().toLocaleString()
  ].filter(Boolean).join('\n');
  const file = () => new File([blob], fileName, { type: 'application/zip' });
  const canShareFile = () => !!(navigator.canShare && navigator.canShare({ files: [file()] }));

  function saveZip() {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fileName;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  async function shareSheet() {
    if (!canShareFile()) return false;
    try { await navigator.share({ files: [file()], title: subject(), text: body() }); return true; }
    catch (e) { return e.name === 'AbortError'; }
  }
  const open = url => { window.location.href = url; };

  const apps = {
    whatsapp: () => { const ph = $('toPhone').value.replace(/\D/g, ''); return `https://wa.me/${ph}?text=${encodeURIComponent(body())}`; },
    telegram: () => `https://t.me/share/url?url=${encodeURIComponent(' ')}&text=${encodeURIComponent(body())}`,
    mail:     () => `mailto:${encodeURIComponent($('toMail').value)}?subject=${encodeURIComponent(subject())}&body=${encodeURIComponent(body() + '\n\n(Attach the saved zip file.)')}`,
    gmail:    () => `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent($('toMail').value)}&su=${encodeURIComponent(subject())}&body=${encodeURIComponent(body() + '\n\n(Attach the saved zip file.)')}`,
    outlook:  () => `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent($('toMail').value)}&subject=${encodeURIComponent(subject())}&body=${encodeURIComponent(body() + '\n\n(Attach the saved zip file.)')}`,
    teams:    () => `https://teams.microsoft.com/share?msgText=${encodeURIComponent(body())}`,
    sms:      () => `sms:${$('toPhone').value.replace(/[^\d+]/g, '')}${/iPhone|iPad/.test(navigator.userAgent) ? '&' : '?'}body=${encodeURIComponent(body())}`,
  };

  $('shareAll').onclick = async () => {
    if (await shareSheet()) return;
    saveZip(); toast('Sharing files is not supported here – the zip was saved to Downloads.');
  };
  document.querySelectorAll('.app').forEach(b => b.onclick = async () => {
    const app = b.dataset.app;
    if (app === 'save') { saveZip(); toast('Zip saved to Downloads'); return; }
    if (['whatsapp', 'telegram', 'teams', 'gmail', 'outlook', 'mail'].includes(app) && canShareFile()) {
      toast(`Choose ${b.textContent.trim()} in the list to attach the zip`);
      if (await shareSheet()) return;
    }
    saveZip(); toast('Zip saved – attach it in the app that opens');
    setTimeout(() => open(apps[app]()), 600);
  });

  $('againBtn').onclick = () => { resetPack(); $('doneArea').classList.add('hidden'); $('scanCard').classList.remove('hidden'); startCamera($('camSelect').value || undefined); };

  // ---------- startup checks ----------
  if (!window.isSecureContext) setMsg('This page must be opened over https for the camera to work.', 'bad');
  else if (typeof jsQR !== 'function') setMsg('The QR reader could not load – check the phone has internet and reload.', 'bad');
})();
