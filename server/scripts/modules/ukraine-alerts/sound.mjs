// Alert tones generated with Web Audio (no audio files).
// Browsers only allow sound after a user gesture, unless started with
// --autoplay-policy=no-user-gesture-required (recommended for the kiosk).

let ctx;

const context = async () => {
	if (!ctx) {
		const AudioCtx = window.AudioContext || window.webkitAudioContext;
		if (!AudioCtx) return null;
		ctx = new AudioCtx();
	}
	if (ctx.state === 'suspended') {
		try { await ctx.resume(); } catch { /* not allowed yet */ }
	}
	return ctx.state === 'running' ? ctx : null;
};

// schedule a list of [frequency, seconds] notes
const play = async (notes, { type = 'square', volume = 0.12 } = {}) => {
	const audio = await context();
	if (!audio) {
		console.warn('Ukraine alerts: audio is blocked by the browser (start Chromium with --autoplay-policy=no-user-gesture-required)');
		return;
	}
	const gain = audio.createGain();
	gain.gain.value = volume;
	gain.connect(audio.destination);
	let t = audio.currentTime + 0.05;
	notes.forEach(([freq, seconds]) => {
		if (freq > 0) {
			const osc = audio.createOscillator();
			osc.type = type;
			osc.frequency.value = freq;
			osc.connect(gain);
			osc.start(t);
			osc.stop(t + seconds);
		}
		t += seconds;
	});
	setTimeout(() => gain.disconnect(), (t - audio.currentTime + 0.5) * 1000);
};

// alternating two-tone attention signal (~4 s)
const playAlertTone = () => {
	const notes = [];
	for (let i = 0; i < 8; i += 1) notes.push([853, 0.25], [960, 0.25]);
	return play(notes, { type: 'square', volume: 0.08 });
};

// soft rising chime
const playClearTone = () => play([[523, 0.25], [659, 0.25], [784, 0.5]], { type: 'sine', volume: 0.2 });

export { playAlertTone, playClearTone };
