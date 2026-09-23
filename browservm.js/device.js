const xterm = new Terminal({
	cursorBlink: true, 
    scrollback: 1000, 
    tabStopWidth: 8
});
xterm.open(document.getElementById('terminal'));

xterm.onKey(e => {
        writeConsole(e.key);
});

const LOCKED_FLAG = 1;
const UNLOCKED_FLAG = 0;
const HARDDISK_PAGE = 512;
class Mutex {
  /**
   * Instantiate Mutex.
   * If opt_sab is provided, the mutex will use it as a backing array.
   * @param {SharedArrayBuffer} opt_sab Optional SharedArrayBuffer.
   */
  constructor(opt_sab) {
    this._sab = opt_sab;
    this._mu = new Int32Array(this._sab);
  }

  try_lock() {
      if (Atomics.compareExchange(this._mu, 0, UNLOCKED_FLAG, LOCKED_FLAG) == UNLOCKED_FLAG) {
        return true;
      }
      return false;
  }

  unlock() {
    if (Atomics.compareExchange(this._mu, 0, LOCKED_FLAG, UNLOCKED_FLAG) != LOCKED_FLAG) {
      throw new Error("Mutex is in inconsistent state: unlock on UNLOCKED_FLAG Mutex.");
    }
    Atomics.notify(this._mu, 0, 1);
  }
}
let startTime = Date.now();
let vm_metrics_sab = undefined;
let ethernetSentPackets = 0;
let ethernetReceivedPackets = 0;
let lastOperationCount = 0;
let lastMetricsTime = performance.now();
let console_output_sab = undefined;
let console_output_sab_mutex = undefined;
let console_input_sab = undefined;
let console_input_sab_mutex = undefined;

let harddisk_output_sab = undefined;
let harddisk_output_sab_mutex = undefined;
let harddisk_input_sab = undefined;
let harddisk_input_sab_mutex = undefined;
let harddiskRequestInFlight = false;
let isoImageCache = null;

const DEFAULT_FS_MB = 256;
const getFilesystemSizeMb = () => {
	const value = Number.parseInt(new URLSearchParams(window.location.search).get('fs'), 10);
	return Number.isFinite(value) && value > 0 ? value : DEFAULT_FS_MB;
};

let ethernet_output_sab = undefined;
let ethernet_output_sab_mutex = undefined;
let ethernet_input_sab = undefined;
let ethernet_input_sab_mutex = undefined;

let emulatorWorker;
const startEmulator = (bootIso) => {
	const params = new URLSearchParams({fs: String(getFilesystemSizeMb())});
	if (bootIso) params.set('root', 'vdb');
	emulatorWorker = new Worker(`emulator.js?${params}`);
	emulatorWorker.onmessage = ev => {
	const data = ev['data'];
	if (data['type'] === 'console_output_sab') {
		console_output_sab = data['buf'];
		console_output_sab_mutex = new Mutex(console_output_sab);
	} else if (data['type'] === 'console_input_sab') {
		console_input_sab = data['buf'];
		console_input_sab_mutex = new Mutex(console_input_sab);
	} else if (data['type'] === 'harddisk_output_sab') {
		harddisk_output_sab = data['buf'];
		harddisk_output_sab_mutex = new Mutex(harddisk_output_sab);
	} else if (data['type'] === 'harddisk_input_sab') {
		harddisk_input_sab = data['buf'];
		harddisk_input_sab_mutex = new Mutex(harddisk_input_sab);
	} else if (data['type'] === 'ethernet_output_sab') {
		ethernet_output_sab = data['buf'];
		ethernet_output_sab_mutex = new Mutex(ethernet_output_sab);
	} else if (data['type'] === 'ethernet_input_sab') {
		ethernet_input_sab = data['buf'];
		ethernet_input_sab_mutex = new Mutex(ethernet_input_sab);
	} else if (data['type'] === 'vm_metrics_sab') {
		vm_metrics_sab = data['buf'];
	}
};
};

startEmulator(false);

const handleConsole = () => {
	if (console_output_sab_mutex.try_lock()) {
		const console_sab_i32a = new Int32Array(console_output_sab);
    	const console_sab_u8a = new Uint8Array(console_output_sab);
		const ulen = console_sab_i32a[1];
		if (ulen > 0) {
			const ustr = console_sab_u8a.slice(8, 8 + ulen);
			console_sab_i32a[1] = 0;
			xterm.write(ustr);
			// const test = new TextDecoder().decode(ustr);
			// if (test.includes('Buildroot')) {
			// 	console.error('Time ' + (Date.now() - startTime));
			// }
		}
	  	console_output_sab_mutex.unlock();
	}
}

const handleHarddisk = async () => {
	if (harddiskRequestInFlight || !harddisk_output_sab_mutex.try_lock()) return;

	let request;
	{
		const harddisk_sab_i32a = new Int32Array(harddisk_output_sab);
		const harddisk_sab_u8a = new Uint8Array(harddisk_output_sab);
		const readOrWrite = harddisk_sab_i32a[3];
		const sector = harddisk_sab_i32a[2];
		const n = harddisk_sab_i32a[1];
		request = {
			readOrWrite,
			sector,
			n,
			outptr: harddisk_sab_i32a[4],
			data: readOrWrite && n > 0
				? harddisk_sab_u8a.slice(16, 16 + n * HARDDISK_PAGE)
				: null
		};
		harddisk_sab_i32a[1] = 0;
		harddisk_output_sab_mutex.unlock();
	}

	if (request.n <= 0) return;
	harddiskRequestInFlight = true;
	try {
		if (request.readOrWrite) {
			for (let j = 0; j < request.n; j++) {
				const block = request.data.slice(j * HARDDISK_PAGE, (j + 1) * HARDDISK_PAGE);
				await idbKeyval.set(`b${request.sector + j}`, block);
			}
			notifyHarddisk(request.n, request.readOrWrite);
		} else {
			if (!isoImageCache) isoImageCache = await idbKeyval.get('iso-image');
			const tmpData = new Uint8Array(request.n * HARDDISK_PAGE);
			if (isoImageCache) {
				const start = request.sector * HARDDISK_PAGE;
				tmpData.set(isoImageCache.subarray(start, start + tmpData.length));
			} else {
				for (let j = 0; j < request.n; j++) {
					const block = await idbKeyval.get(`b${request.sector + j}`);
					if (block) tmpData.set(block, j * HARDDISK_PAGE);
				}
			}
			notifyHarddisk(request.n, request.readOrWrite, request.outptr, tmpData);
		}
	} finally {
		harddiskRequestInFlight = false;
	}
}

/* ---------------------------------------------------------------------
 * Ethernet: WebSocket relay transport.
 *
 * The guest's virtio-net device and the worker<->main-thread SharedArrayBuffer
 * pipe (ethernet_output_sab / ethernet_input_sab) are already wired up by
 * main.c / library.js. This relay is the piece that was missing: it forwards
 * raw Ethernet frames the guest sends to a WebSocket relay server, and
 * injects frames the relay sends back into ethernet_input_sab so the guest's
 * virtio-net driver picks them up via lib_ethernet_input.
 *
 * Protocol: one binary WebSocket message == one raw Ethernet frame, in each
 * direction. No extra framing. This matches the relay protocol used by other
 * browser-VM projects (e.g. v86's network relay), so a v86-compatible relay
 * (self-hosted or public) should work here without changes. The relay server
 * itself runs a user-mode NAT/SLIRP stack and is NOT part of this repo.
 * ------------------------------------------------------------------- */
const ETHERNET_RELAY_URL =
	(typeof window !== 'undefined' && window.BROWSERVM_RELAY_URL) ||
	'ws://localhost:8080/';
const ETHERNET_MAX_QUEUED_FRAMES = 32;

let ethernetSocket = null;
let ethernetSocketReady = false;
let ethernetSendQueue = [];
let ethernetReconnectTimer = null;

const connectEthernetRelay = () => {
	if (ethernetReconnectTimer) {
		clearTimeout(ethernetReconnectTimer);
		ethernetReconnectTimer = null;
	}
	let socket;
	try {
		socket = new WebSocket(ETHERNET_RELAY_URL);
		socket.binaryType = 'arraybuffer';
	} catch (e) {
		console.error('Ethernet relay: failed to open socket', e);
		ethernetReconnectTimer = setTimeout(connectEthernetRelay, 3000);
		return;
	}
	ethernetSocket = socket;

	socket.onopen = () => {
		if (socket !== ethernetSocket) return;
		ethernetSocketReady = true;
		console.log('Ethernet relay connected: ' + ETHERNET_RELAY_URL);
		for (const frame of ethernetSendQueue) {
			socket.send(frame);
		}
		ethernetSendQueue = [];
	};

	socket.onmessage = (ev) => {
		if (socket !== ethernetSocket) return;
		const frame = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : null;
		if (frame) {
			ethernetReceivedPackets++;
			deliverEthernetFrame(frame);
		}
	};

	socket.onclose = () => {
		if (socket !== ethernetSocket) return;
		ethernetSocketReady = false;
		ethernetSocket = null;
		ethernetReconnectTimer = setTimeout(connectEthernetRelay, 3000);
	};

	socket.onerror = (e) => {
		console.error('Ethernet relay error', e);
	};
};

/* Called from handleEthernet() below with a frame the guest sent out. */
const sendEthernetFrame = (frame) => {
	if (ethernetSocketReady && ethernetSocket) {
		ethernetSocket.send(frame);
		ethernetSentPackets++;
	} else if (ethernetSendQueue.length < ETHERNET_MAX_QUEUED_FRAMES) {
		/* Queue a bounded burst (e.g. the guest's first DHCP discover) while
		 * the relay socket is (re)connecting, instead of silently dropping it. */
		ethernetSendQueue.push(frame);
	}
};

/* Called from the relay's onmessage with a frame to hand to the guest.
 * Writes it into ethernet_input_sab for lib_ethernet_input (worker side)
 * to pick up. If the guest hasn't drained the previous inbound frame yet,
 * or the SAB lock is held by the worker right now, the frame is dropped —
 * TCP retransmits, and this keeps the hardware-poll loop from blocking. */
const deliverEthernetFrame = (frame) => {
	if (!ethernet_input_sab_mutex) return;
	if (ethernet_input_sab_mutex.try_lock()) {
		const ethernet_sab_i32a = new Int32Array(ethernet_input_sab);
		const ethernet_sab_u8a = new Uint8Array(ethernet_input_sab);
		const capacity = ethernet_input_sab.byteLength - 8;
		if (ethernet_sab_i32a[1] === 0 && frame.length <= capacity) {
			ethernet_sab_u8a.set(frame, 8);
			ethernet_sab_i32a[1] = frame.length;
		}
		ethernet_input_sab_mutex.unlock();
	}
};

const handleEthernet = async () => {
	if (ethernet_output_sab_mutex.try_lock()) {
		const ethernet_sab_i32a = new Int32Array(ethernet_output_sab);
		const ethernet_sab_u8a = new Uint8Array(ethernet_output_sab);
		const ulen = ethernet_sab_i32a[1];
		if (ulen > 0) {
			const ustr = ethernet_sab_u8a.slice(8, 8 + ulen);
			ethernet_sab_i32a[1] = 0;
			sendEthernetFrame(ustr);
		}
		ethernet_output_sab_mutex.unlock();
	}
};

const handleHardwareReq = async () => {

	if (!console_output_sab || !harddisk_output_sab || !ethernet_output_sab) {
		setTimeout(handleHardwareReq, 1000);
		return;
	}

	/* If we can hold the lock */
	handleConsole();
	
	await handleHarddisk();

	await handleEthernet();

	setTimeout(handleHardwareReq, 0);
};

/* Should never failed to lock */
const notifyHarddisk = (blockn, readOrWrite, outptr, data) => {
	if (harddisk_input_sab_mutex.try_lock()) {
		const harddisk_sab_i32a = new Int32Array(harddisk_input_sab);
    	const harddisk_sab_u8a = new Uint8Array(harddisk_input_sab);
		
		harddisk_sab_i32a[1] = blockn;
		harddisk_sab_i32a[2] = readOrWrite;
		if (!readOrWrite) {
			harddisk_sab_i32a[3] = outptr;
			harddisk_sab_u8a.set(data, 16);

		}
		// console.log('done ' + readOrWrite);
		harddisk_input_sab_mutex.unlock();
	} else {
		console.error('locking failed');
	}
}

const writeConsole = (key) => {
	if (console_input_sab_mutex.try_lock()) {
		const console_sab_i32a = new Int32Array(console_input_sab);
    	const console_sab_u8a = new Uint8Array(console_input_sab);
		let data = new Uint8Array(1);
		data[0] = key.charCodeAt(0);
		console_sab_i32a[1] = 1;
		console_sab_u8a.set(data, 8);
		console_input_sab_mutex.unlock();
	}
}

window.restartEmulator = () => {
	if (emulatorWorker) emulatorWorker.terminate();
	console_output_sab = undefined;
	harddisk_output_sab = undefined;
	isoImageCache = null;
	ethernet_output_sab = undefined;
	vm_metrics_sab = undefined;
	lastOperationCount = 0;
	lastMetricsTime = performance.now();
	startEmulator(true);
};

const updateMetrics = () => {
	const operationsEl = document.getElementById('operations-per-second');
	const ethernetEl = document.getElementById('ethernet-stats');
	const memoryEl = document.getElementById('memory-usage');
	const now = performance.now();
	if (vm_metrics_sab && operationsEl) {
		const count = Atomics.load(new Int32Array(vm_metrics_sab), 1);
		const elapsed = Math.max(now - lastMetricsTime, 1);
		operationsEl.textContent = `Operations/s: ${Math.round((count - lastOperationCount) * 1000 / elapsed).toLocaleString()}`;
		lastOperationCount = count;
		lastMetricsTime = now;
	}
	if (ethernetEl) {
		ethernetEl.textContent = `Ethernet sent: ${ethernetSentPackets.toLocaleString()} | received: ${ethernetReceivedPackets.toLocaleString()}`;
	}
	if (memoryEl) {
		const memory = performance.memory;
		memoryEl.textContent = memory
			? `Memory: ${(memory.usedJSHeapSize / 1048576).toFixed(1)} / ${(memory.jsHeapSizeLimit / 1048576).toFixed(0)} MB`
			: 'Memory: unavailable';
	}
};

setInterval(updateMetrics, 1000);

/* Kick out the event loop */
setTimeout(handleHardwareReq, 1000);
connectEthernetRelay();