// ==========================================
// IMPORT FIREBASE
// ==========================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, collection, addDoc, onSnapshot, query, orderBy, limit, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ==========================================
// 1. CLASS MOCK FIRESTORE
// ==========================================
class MockFirestore {
    constructor() {
        this.data = JSON.parse(localStorage.getItem('mock_inventory_db') || '[]');
        this.listeners = [];
    }

    collection() { return this; }

    async add(payload) {
        const doc = {
            ...payload,
            id: Date.now().toString(),
            timestamp: new Date().toISOString()
        };
        this.data.unshift(doc);
        if (this.data.length > 50) this.data.pop();
        localStorage.setItem('mock_inventory_db', JSON.stringify(this.data));
        this.listeners.forEach(cb => cb({ docs: this.data.map(d => ({ data: () => d })) }));
        return Promise.resolve();
    }

    onSnapshot(cb) {
        this.listeners.push(cb);
        cb({ docs: this.data.map(d => ({ data: () => d })) });
        return () => {};
    }
}

// ==========================================
// 2. FIREBASE CONFIGURATION
// ==========================================
const firebaseConfig = {
    apiKey: "AIzaSyD8asrYuI8OPB2Csc4gc4A7GHSMUscjL54",
    authDomain: "project-ai-cam-76c4a.firebaseapp.com",
    projectId: "project-ai-cam-76c4a",
    storageBucket: "project-ai-cam-76c4a.firebasestorage.app",
    messagingSenderId: "677766278552",
    appId: "1:677766278552:web:9590e569c773007fffcfed"
};

let db;
let isMockMode = true;
let collectionRef;
const modeBadge = document.getElementById('mode-badge');

if (firebaseConfig.apiKey && firebaseConfig.projectId) {
    try {
        const app = initializeApp(firebaseConfig);
        db = getFirestore(app);
        isMockMode = false;
        collectionRef = collection(db, "detection_logs");
        modeBadge.textContent = "ONLINE";
        modeBadge.classList.add('online');
        console.log("✅ Terhubung ke Firebase");
    } catch (e) {
        console.error("Firebase init error", e);
    }
}

if (isMockMode) {
    db = new MockFirestore();
    collectionRef = db.collection();
    modeBadge.textContent = "DEMO";
    console.log("⚠️ Menggunakan Mock Database");
}

// ==========================================
// 3. VARIABEL GLOBAL
// ==========================================
let model = null;
let currentStream = null;
let isCameraOn = false;
let isAIDetecting = false;
let lastSaveTime = 0;
let facingMode = 'environment';
let flashOn = false;
let currentPage = 'scanner';
const SAVE_THROTTLE_MS = 3000;

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const overlay = document.getElementById('camera-overlay');
const overlayText = document.getElementById('overlay-text');
const detectionInfo = document.getElementById('detection-info');
const detectedClass = document.getElementById('detected-class');
const detectedSummary = document.getElementById('detected-summary');
const detectedTags = document.getElementById('detected-tags');
const logBadge = document.getElementById('log-badge');

// ==========================================
// 4. DAFTAR KELAS TARGET
// ==========================================
const TARGET_CLASSES = [
    'cell phone',
    'mouse',
    'laptop',
    'keyboard',
    'person',
    'book',
    'scissors'
];

const CLASS_COLORS = {
    'cell phone': '#ff6b6b',
    'mouse': '#4ecdc4',
    'laptop': '#45b7d1',
    'keyboard': '#96ceb4',
    'person': '#6c5ce7',
    'book': '#feca57',
    'scissors': '#fd79a8'
};

// ==========================================
// 5. FUNGSI UTILITY
// ==========================================
function showOverlay(text) {
    overlay.classList.remove('hidden');
    overlayText.textContent = text;
}

function hideOverlay() {
    overlay.classList.add('hidden');
}

function showToast(message, isError = false) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = 'toast' + (isError ? ' error' : '');
    toast.style.display = 'block';
    setTimeout(() => {
        toast.style.display = 'none';
    }, 3000);
}

function updateDetectionInfo(predictions) {
    if (predictions.length === 0) {
        detectionInfo.style.display = 'none';
        return;
    }

    // Ambil prediksi dengan confidence tertinggi
    const topPred = predictions.reduce((max, p) => 
        p.confidence > max.confidence ? p : max, predictions[0]
    );

    detectedClass.textContent = topPred.class;
    detectedSummary.textContent = `Terdeteksi ${predictions.length} objek • Confidence ${topPred.confidence}%`;

    detectedTags.innerHTML = predictions.map(p => 
        `<span class="tag-chip" style="background: ${CLASS_COLORS[p.class] || '#6c5ce7'}">${p.class} • ${p.confidence}%</span>`
    ).join('');

    detectionInfo.style.display = 'block';
}

// ==========================================
// 6. FUNGSI MEMUAT MODEL AI
// ==========================================
async function loadModel() {
    showOverlay("Memuat Model AI...");

    try {
        if (typeof cocoSsd === 'undefined') {
            throw new Error("Library COCO-SSD belum termuat.");
        }

        model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
        hideOverlay();
        showToast("Model AI siap digunakan!");
        console.log("✅ Model berhasil dimuat");

    } catch (err) {
        console.error("Gagal memuat model:", err);
        showOverlay("Gagal Memuat Model AI");
    }
}

// ==========================================
// 7. FUNGSI SAVE TO DATABASE
// ==========================================
async function saveToDatabase(data) {
    try {
        const itemsString = data.map(d => 
            `${d.class} (${d.confidence}%)`
        ).join(', ');

        const payload = {
            items: itemsString,
            count: data.length,
            device_id: 'BROWSER-TEST',
            timestamp: isMockMode 
                ? new Date().toISOString() 
                : serverTimestamp()
        };

        await addDoc(collectionRef, payload);
        console.log("💾 Data tersimpan:", payload);
    } catch (err) {
        console.error("Gagal menyimpan ke database:", err);
    }
}

// ==========================================
// 8. FUNGSI DETECT LOOP
// ==========================================
async function detectLoop() {
    if (!isAIDetecting || !isCameraOn) return;

    try {
        const predictions = await model.detect(video);
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        let detectedTargets = [];

        predictions.forEach(pred => {
            const [x, y, w, h] = pred.bbox;
            const isTarget = TARGET_CLASSES.includes(pred.class);
            const confidence = pred.score;

            if (isTarget && confidence > 0.60) {
                detectedTargets.push({
                    class: pred.class,
                    confidence: parseFloat((confidence * 100).toFixed(0))
                });

                const color = CLASS_COLORS[pred.class] || '#6c5ce7';

                ctx.strokeStyle = color;
                ctx.lineWidth = 3;
                ctx.strokeRect(x, y, w, h);

                const label = `${pred.class} ${(confidence * 100).toFixed(0)}%`;
                ctx.fillStyle = color;
                const textWidth = ctx.measureText(label).width;
                ctx.fillRect(x, y - 25, textWidth + 10, 25);
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 14px sans-serif';
                ctx.fillText(label, x + 5, y - 7);
            }
        });

        // Update info panel
        updateDetectionInfo(detectedTargets);

        // Throttled save
        if (detectedTargets.length > 0 && (Date.now() - lastSaveTime > SAVE_THROTTLE_MS)) {
            saveToDatabase(detectedTargets);
            lastSaveTime = Date.now();
        }

    } catch (err) {
        console.error("Error saat deteksi:", err);
    }

    requestAnimationFrame(detectLoop);
}

// ==========================================
// 9. FUNGSI KAMERA
// ==========================================
async function startCamera() {
    try {
        showOverlay('Menghubungkan Kamera...');

        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: facingMode,
                width: { ideal: 1280 },
                height: { ideal: 720 }
            },
            audio: false
        });

        currentStream = stream;
        isCameraOn = true;
        video.srcObject = stream;

        await new Promise(resolve => {
            video.onloadedmetadata = () => {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                resolve();
            };
        });

        hideOverlay();
        console.log("✅ Kamera berhasil dinyalakan!");

    } catch (err) {
        console.error("Gagal akses kamera:", err);
        showOverlay('Gagal Mengakses Kamera');
        showToast("Akses kamera ditolak!", true);
    }
}

function stopCamera() {
    if (currentStream) {
        if (isAIDetecting) {
            isAIDetecting = false;
            document.getElementById('btn-ai').classList.remove('active');
        }

        currentStream.getTracks().forEach(track => track.stop());
        currentStream = null;
        isCameraOn = false;
        video.srcObject = null;

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        detectionInfo.style.display = 'none';

        console.log(" Kamera dimatikan.");
    }
}

async function switchCamera() {
    facingMode = facingMode === 'environment' ? 'user' : 'environment';
    stopCamera();
    await startCamera();
    showToast(`Kamera ${facingMode === 'environment' ? 'belakang' : 'depan'}`);
}

function toggleFlash() {
    flashOn = !flashOn;
    const btnFlash = document.getElementById('btn-flash');
    
    if (flashOn) {
        btnFlash.classList.add('active');
        showToast("Flash ON");
    } else {
        btnFlash.classList.remove('active');
        showToast("Flash OFF");
    }
}

// ==========================================
// 10. FUNGSI NAVIGASI
// ==========================================
function switchPage(page) {
    currentPage = page;
    const navScanner = document.getElementById('nav-scanner');
    const navLog = document.getElementById('nav-log');
    const logPage = document.getElementById('log-page');

    if (page === 'scanner') {
        navScanner.classList.add('active');
        navLog.classList.remove('active');
        logPage.style.display = 'none';
    } else if (page === 'log') {
        navLog.classList.add('active');
        navScanner.classList.remove('active');
        logPage.style.display = 'flex';
    }
}

// ==========================================
// 11. FUNGSI LISTEN DATABASE
// ==========================================
function listenToDatabase() {
    console.log("👂 Mendengarkan perubahan database...");
    
    if (isMockMode) {
        collectionRef.onSnapshot(snapshot => {
            renderLogList(snapshot);
        });
    } else {
        const q = query(
            collectionRef, 
            orderBy("timestamp", "desc"), 
            limit(30)
        );
        
        onSnapshot(q, snapshot => {
            renderLogList(snapshot);
        });
    }
}

function renderLogList(snapshot) {
    const logList = document.getElementById('log-list');
    const logCountHeader = document.getElementById('log-count-header');
    logList.innerHTML = '';

    let count = 0;
    const docs = snapshot.docs || snapshot;

    docs.forEach(doc => {
        count++;
        const data = doc.data ? doc.data() : doc;

        let timeStr;
        if (data.timestamp) {
            const date = typeof data.timestamp === 'string' 
                ? new Date(data.timestamp)
                : data.timestamp.toDate();
            timeStr = date.toLocaleTimeString("id-ID");
        } else {
            timeStr = 'Baru saja';
        }

        const div = document.createElement('div');
        div.className = 'log-item';
        div.innerHTML = `
            <span class="time">${timeStr}</span>
            <span class="items">${data.items || '-'}</span>
        `;
        logList.appendChild(div);
    });

    logCountHeader.textContent = `${count} Items`;
    logBadge.textContent = count;
    logBadge.classList.toggle('hidden', count === 0);

    if (count === 0) {
        logList.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-inbox"></i>
                <p>Belum ada objek terdeteksi</p>
            </div>
        `;
    }
}

// ==========================================
// 12. EVENT LISTENERS
// ==========================================
document.getElementById('btn-camera').addEventListener('click', () => {
    if (isCameraOn) {
        stopCamera();
        showToast("Kamera dimatikan");
    } else {
        startCamera();
    }
});

document.getElementById('btn-switch').addEventListener('click', switchCamera);

document.getElementById('btn-ai').addEventListener('click', () => {
    if (!model) {
        showToast("Model AI belum siap!", true);
        return;
    }

    if (isAIDetecting) {
        isAIDetecting = false;
        document.getElementById('btn-ai').classList.remove('active');
        detectionInfo.style.display = 'none';
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        showToast("AI Scan dihentikan");
    } else {
        if (!isCameraOn) {
            showToast("Nyalakan kamera dulu!", true);
            return;
        }
        isAIDetecting = true;
        document.getElementById('btn-ai').classList.add('active');
        showToast("AI Scan dimulai");
        detectLoop();
    }
});

document.getElementById('btn-flash').addEventListener('click', toggleFlash);

document.getElementById('nav-scanner').addEventListener('click', () => switchPage('scanner'));
document.getElementById('nav-log').addEventListener('click', () => switchPage('log'));

// ==========================================
// 13. INISIALISASI
// ==========================================
function initApp() {
    console.log(" Memulai inisialisasi aplikasi...");
    listenToDatabase();
    loadModel();
    console.log("✅ Inisialisasi selesai!");
}

document.addEventListener('DOMContentLoaded', initApp);