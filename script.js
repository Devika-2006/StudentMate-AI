/**
 * ==========================================
 * ACOUSTIC CLASSIFIER AI - CORE CONTROLLER
 * ==========================================
 * 
 * This script implements a One-Shot State Machine Audio Classifier using:
 * - Google Teachable Machine Audio Model
 * - TensorFlow.js & @tensorflow-models/speech-commands
 * - Web Audio API (AnalyserNode) to monitor peak audio volumes.
 */

// --- Constants & Global State ---
// Teachable Machine base URL hosting the model assets
const URL = "https://teachablemachine.withgoogle.com/models/hh8MwC0Iw/";

// Speech recognition model instance
let recognizer = null;

// Array to store names of categories extracted from the model's metadata
let classLabels = [];

/**
 * ONE-SHOT STATE MACHINE STATES:
 * - 'IDLE'           : Initial state. Microphone is off. App is resting.
 * - 'LISTENING'      : Mic is active. Continuously calculating volume peak. Silence is ignored.
 * - 'SOUND_DETECTED' : Noise peak exceeded threshold. Volume checks pause to prevent double-triggers.
 * - 'PREDICTING'     : Waiting for sound to settle (cooldown), then flags next model output as final.
 * - 'RESULT'         : Single prediction processed and displayed.
 * - 'STOPPED'        : Final cleanup. Mic tracks disabled, AudioContext closed, buttons reset.
 */
let appState = 'IDLE';

// Audio Context & Microphone Stream references
let micStream = null;      // Holds the raw MediaStream from getUserMedia()
let audioContext = null;   // Standard Web Audio context
let analyser = null;       // Audio node performing Fast Fourier Transform & volume mapping
let animationFrameId = null; // ID to track and cancel volume polling loops

// Peak detection threshold configurations
const VOLUME_THRESHOLD = 0.12; // Sound peak amplitude threshold (room ambient noise is ~0.02)
const CAPTURE_COOLDOWN = 700;   // Wait time in milliseconds to let user finish making a sound
let shouldCapture = false;      // Gate flag: true only when we are ready to take one TFJS output

// --- UI Elements Object Mapping ---
const dom = {
    btnStart: document.getElementById('btn-start'),
    btnStop: document.getElementById('btn-stop'),
    modelStatusDot: document.getElementById('model-status-dot'),
    modelStatusText: document.getElementById('model-status-text'),
    micStatusDot: document.getElementById('mic-status-dot'),
    micStatusText: document.getElementById('mic-status-text'),
    shimmerContainer: document.getElementById('model-loading-shimmer'),
    predictedClass: document.getElementById('predicted-class'),
    confidencePercentage: document.getElementById('confidence-percentage'),
    confidenceBar: document.getElementById('confidence-bar'),
    probabilitiesContainer: document.getElementById('probabilities-container'),
    errorBanner: document.getElementById('error-banner'),
    errorMessage: document.getElementById('error-message'),
    btnCloseError: document.getElementById('btn-close-error')
};

// --- Page Start Event Listener ---
window.addEventListener('DOMContentLoaded', () => {
    // Render initial Lucide icons if the module is loaded
    if (window.lucide) {
        window.lucide.createIcons();
    }
    
    // Bind click events to elements
    dom.btnStart.addEventListener('click', startListening);
    dom.btnStop.addEventListener('click', stopListening);
    dom.btnCloseError.addEventListener('click', hideError);
    
    // Automatically trigger model downloading when the page starts
    loadTeachableMachineModel();
});

// --- Error Banner UI Controllers ---
function showError(message) {
    console.error("Application Error: ", message);
    dom.errorMessage.textContent = message;
    dom.errorBanner.classList.remove('hidden'); // Display the error panel on page header
}

function hideError() {
    dom.errorBanner.classList.add('hidden'); // Hide the error panel
}

// --- Status Badge State Updates ---
function updateModelStatus(state, text) {
    dom.modelStatusDot.className = 'dot';
    
    if (state === 'loading') {
        dom.modelStatusDot.classList.add('dot-loading');
        dom.modelStatusText.textContent = text || 'Loading...';
        dom.shimmerContainer.classList.remove('hidden'); // Show loading shimmer
    } else if (state === 'ready') {
        dom.modelStatusDot.classList.add('dot-ready');
        dom.modelStatusText.textContent = text || 'Ready';
        dom.shimmerContainer.classList.add('hidden'); // Hide loading shimmer
    } else if (state === 'error') {
        dom.modelStatusDot.classList.add('dot-error');
        dom.modelStatusText.textContent = text || 'Load Failed';
        dom.shimmerContainer.classList.add('hidden'); // Hide loading shimmer
    }
}

function updateMicStatus(state, text) {
    dom.micStatusDot.className = 'dot';
    
    if (state === 'listening') {
        dom.micStatusDot.classList.add('dot-listening');
        dom.micStatusText.textContent = text || 'Listening';
    } else if (state === 'stopped') {
        dom.micStatusText.textContent = text || 'Stopped';
    } else if (state === 'error') {
        dom.micStatusDot.classList.add('dot-error');
        dom.micStatusText.textContent = text || 'Error';
    }
}

// --- State Machine Transition Handler ---
function transitionTo(newState) {
    appState = newState;
    console.log(`State transition to: ${newState}`);
    
    switch (newState) {
        case 'IDLE':
        case 'STOPPED':
            updateMicStatus('stopped', 'Stopped');
            dom.btnStart.disabled = false; // Allow listening trigger
            dom.btnStop.disabled = true;  // Disable stop trigger
            break;
            
        case 'LISTENING':
            updateMicStatus('listening', 'Listening... (Silence)');
            dom.btnStart.disabled = true;  // Prevent duplicate streams
            dom.btnStop.disabled = false; // Allow manual stop cancel
            break;
            
        case 'SOUND_DETECTED':
            updateMicStatus('listening', 'Sound Detected!');
            break;
            
        case 'PREDICTING':
            updateMicStatus('listening', 'Classifying...');
            break;
            
        case 'RESULT':
            updateMicStatus('listening', 'Result Ready');
            break;
    }
}

// --- Load Teachable Machine Audio Model ---
async function loadTeachableMachineModel() {
    updateModelStatus('loading', 'Downloading weights...');
    hideError();
    
    try {
        // Build direct URLs pointing to Teachable Machine files
        const checkpointURL = URL + "model.json";
        const metadataURL = URL + "metadata.json";
        
        // Initialize SpeechCommands recognizer instance using standard FFT configuration
        recognizer = speechCommands.create(
            "BROWSER_FFT",
            undefined,
            checkpointURL,
            metadataURL
        );
        
        // Wait for model files to compile and download binary weights
        await recognizer.ensureModelLoaded();
        
        // Extract names of the trained categories (words/sounds) from model metadata
        classLabels = recognizer.wordLabels();
        
        // Draw the initial list of visual progress bars
        renderProbabilityBars();
        
        updateModelStatus('ready', 'Model Loaded');
        transitionTo('IDLE');
        
    } catch (error) {
        updateModelStatus('error', 'Load Failed');
        showError(`Model loading error: Could not fetch files from URL "${URL}". Ensure you are online and that CORS is allowed.`);
    }
}

// --- Dynamic Probability Bars Builder ---
function renderProbabilityBars() {
    if (!classLabels || classLabels.length === 0) {
        dom.probabilitiesContainer.innerHTML = '<div class="placeholder-text">No classes loaded.</div>';
        return;
    }
    
    dom.probabilitiesContainer.innerHTML = '';
    
    classLabels.forEach((label, index) => {
        const row = document.createElement('div');
        row.className = 'prob-row';
        row.id = `prob-row-${index}`;
        
        // Replace underscore indicators for background noise category
        const cleanName = label === '_background_noise_' ? 'Background Noise' : label;
        
        row.innerHTML = `
            <div class="prob-meta">
                <span class="prob-name" id="prob-name-${index}" title="${cleanName}">${cleanName}</span>
                <span class="prob-score" id="prob-val-${index}">0%</span>
            </div>
            <div class="prob-bar-track">
                <div class="prob-bar-fill" id="prob-fill-${index}"></div>
            </div>
        `;
        
        dom.probabilitiesContainer.appendChild(row);
    });
}

// --- Real-Time Peak Volume Polling Loop ---
function monitorVolume() {
    // Only query mic volume if we are actively waiting for sound
    if (appState !== 'LISTENING' || !analyser) return;

    const bufferLength = analyser.fftSize;
    const dataArray = new Float32Array(bufferLength);
    
    // Retrieve instantaneous time domain amplitude array (-1.0 to 1.0)
    analyser.getFloatTimeDomainData(dataArray);

    // Track the absolute peak amplitude within current buffer
    let peak = 0;
    for (let i = 0; i < bufferLength; i++) {
        const val = Math.abs(dataArray[i]);
        if (val > peak) {
            peak = val;
        }
    }

    // Trigger state transition if volume spikes above threshold (e.g. whistle/clap)
    if (peak > VOLUME_THRESHOLD) {
        // Transition immediately. This cancels requestAnimationFrame loop automatically.
        transitionTo('SOUND_DETECTED');
        
        // Cooldown timer: Allows user to finish speaking or clapping before calling prediction
        setTimeout(() => {
            if (appState === 'SOUND_DETECTED') {
                transitionTo('PREDICTING');
                shouldCapture = true; // Open prediction capture gate
            }
        }, CAPTURE_COOLDOWN);
    } else {
        // Re-call loop recursively on next monitor frame
        animationFrameId = requestAnimationFrame(monitorVolume);
    }
}

// --- Start Microphone Capture and Monitoring ---
async function startListening() {
    // Guard against starting parallel mic streams
    if (appState === 'LISTENING' || appState === 'SOUND_DETECTED' || appState === 'PREDICTING' || !recognizer) return;
    
    hideError();
    resetPredictionDisplay();
    shouldCapture = false;
    transitionTo('LISTENING');

    try {
        // Request microphone permission and access stream
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        
        // Create audio graph nodes to monitor volume peaks
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioContext.createMediaStreamSource(micStream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);

        // Start volume monitoring
        monitorVolume();

        // Start SpeechCommands engine capture in parallel
        await recognizer.listen(
            (result) => {
                // Ignore predictions unless sound is detected and cooldown completes
                if (appState !== 'PREDICTING' || !shouldCapture) return;
                
                shouldCapture = false; // Lock gate immediately to prevent double processing
                processOneShotPrediction(result);
            },
            {
                includeSpectrogram: false,
                probabilityThreshold: 0.0, // continuous callback frequency
                overlapFactor: 0.5,
                invokeCallbackOnNoiseAndUnknown: true
            }
        );
        
    } catch (error) {
        // Handle denied mic permissions or system capture locks
        isListening = false;
        transitionTo('IDLE');
        updateMicStatus('error', 'Access Denied');
        showError("Microphone access error: Ensure microphone is connected and permission is granted.");
    }
}

// --- Stop Microphone stream and Free Hardware Locks ---
async function stopListening() {
    // Guard if already stopped
    if (appState === 'IDLE' || appState === 'STOPPED') return;
    
    dom.btnStop.disabled = true;
    
    try {
        // Disable TFJS speech recognizer microphone loops
        if (recognizer) {
            await recognizer.stopListening();
        }
    } catch (error) {
        console.error("Error stopping recognizer: ", error);
    }
    
    // Stop peak volume recursive monitoring frame loops
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
    
    // Turn off recording indicator lights by stopping all tracks
    if (micStream) {
        micStream.getTracks().forEach(track => track.stop());
        micStream = null;
    }
    
    // Close Web Audio Context and release memory
    if (audioContext) {
        if (audioContext.state !== 'closed') {
            await audioContext.close();
        }
        audioContext = null;
    }
    
    transitionTo('STOPPED');
}

// --- Process the SINGLE predicted classification output ---
async function processOneShotPrediction(result) {
    try {
        const scores = result.scores;
        let maxIndex = 0;
        let maxScore = 0;
        
        // Find index of highest scoring label and update progress bars
        for (let i = 0; i < scores.length; i++) {
            const score = scores[i];
            const pct = Math.round(score * 100);
            
            const fillEl = document.getElementById(`prob-fill-${i}`);
            const textEl = document.getElementById(`prob-val-${i}`);
            const rowEl = document.getElementById(`prob-row-${i}`);
            
            if (fillEl && textEl && rowEl) {
                fillEl.style.width = `${pct}%`;
                textEl.textContent = `${pct}%`;
                
                // Highlight classes crossing 50% probability boundary
                if (score > 0.5) {
                    rowEl.classList.add('row-active');
                } else {
                    rowEl.classList.remove('row-active');
                }
            }
            
            if (score > maxScore) {
                maxScore = score;
                maxIndex = i;
            }
        }
        
        // Display values inside display panels
        const predictedWord = classLabels[maxIndex];
        const cleanWord = predictedWord === '_background_noise_' ? 'Background Noise' : predictedWord;
        const confidencePct = Math.round(maxScore * 100);
        
        dom.predictedClass.textContent = cleanWord;
        dom.confidencePercentage.textContent = `${confidencePct}%`;
        dom.confidenceBar.style.width = `${confidencePct}%`;
        
        // Trigger visual card animation bounce
        if (cleanWord !== 'Background Noise') {
            dom.predictedClass.classList.remove('pulse-trigger');
            void dom.predictedClass.offsetWidth;
            dom.predictedClass.classList.add('pulse-trigger');
        }
        
        // Shift state machine state to RESULT
        transitionTo('RESULT');
        
        // Stop audio capture and release tracks immediately
        await stopListening();
        
    } catch (error) {
        console.error("Error in one-shot prediction processing: ", error);
        await stopListening();
    }
}

// --- Reset Prediction UI Cards ---
function resetPredictionDisplay() {
    dom.predictedClass.textContent = '--';
    dom.confidencePercentage.textContent = '0%';
    dom.confidenceBar.style.width = '0%';
    
    for (let i = 0; i < classLabels.length; i++) {
        const fillEl = document.getElementById(`prob-fill-${i}`);
        const textEl = document.getElementById(`prob-val-${i}`);
        const rowEl = document.getElementById(`prob-row-${i}`);
        
        if (fillEl && textEl && rowEl) {
            fillEl.style.width = '0%';
            textEl.textContent = '0%';
            rowEl.classList.remove('row-active');
        }
    }
}
