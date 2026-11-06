/*
 * BetterVSC jelly cursor
 * BETTERVSC_CURSOR_V3
 *
 * Neovide-style spring cursor for the editor and the integrated terminal.
 *
 * Editor:   tracks .monaco-editor .cursor
 * Terminal: tracks .xterm-cursor inside the focused .xterm.
 * Explorer: tracks the focused .monaco-list-row in the file tree and gives it
 *           a translucent jelly highlight plus a persistent IME-colored tint.
 *           The xterm DOM renderer is used, so keep
 *           terminal.integrated.gpuAcceleration = "off".
 *
 * Cursor color follows the IME state:
 *   Chinese (娑? -> Bilibili pink #FB7299
 *   English (閼? -> Luo Tianyi blue #66CCFF
 *
 * The renderer cannot read the Windows IME conversion mode directly, so the
 * state is inferred from composition events, IME keydown events (keyCode 229)
 * and a lone Shift press (the usual Chinese/English toggle).
 */

(() => {
	"use strict";

	// ------------------------------------------------------------------
	// Appearance
	// ------------------------------------------------------------------
	const CURSOR_COLORS = {
		zh: "#FB7299", // Bilibili pink
		en: "#66CCFF", // Luo Tianyi blue
	};
	const CURSOR_ACCENT = "#0b0b0b";
	const tailOpacity = 1;

	const useShadow = true;
	const shadowBlurFactor = 0.5;

	// Explorer tree highlight (translucent so file names stay readable).
	const TREE_FILL_OPACITY = 0.32;
	const TREE_OVERLAY_OPACITY = 0.22;
	const TREE_STROKE_OPACITY = 0.9;
	const TREE_SHADOW_BLUR = 10;

	// ------------------------------------------------------------------
	// IME state
	// ------------------------------------------------------------------
	const IME_STATE_KEY = "bettervsc.imeState";
	let imeState = "en";

	try {
		if (localStorage.getItem(IME_STATE_KEY) === "zh") imeState = "zh";
	} catch {
		// localStorage can be unavailable in some auxiliary windows.
	}

	const currentCursorColor = () => CURSOR_COLORS[imeState];

	const softCursorColorCss = () => {
		const color = resolveColor(currentCursorColor());
		return rgbaToCss({
			...color,
			a: (color.a * TREE_FILL_OPACITY) >> 0,
		});
	};

	const setImeState = (state) => {
		if (state !== "zh" && state !== "en") return;
		if (imeState === state) return;
		imeState = state;
		try {
			localStorage.setItem(IME_STATE_KEY, state);
		} catch {
			// Ignore.
		}
		document.documentElement.style.setProperty(
			"--bettervsc-cursor-color",
			currentCursorColor()
		);
		document.documentElement.style.setProperty(
			"--bettervsc-cursor-color-soft",
			softCursorColorCss()
		);
	};

	const toggleImeState = () => {
		setImeState(imeState === "zh" ? "en" : "zh");
	};

	// ------------------------------------------------------------------
	// Timing
	// ------------------------------------------------------------------
	const animationLength = 0.105;
	const shortAnimationLength = 0.042;
	const shortMoveThreshold = 8;

	// ------------------------------------------------------------------
	// Trail dynamics
	// ------------------------------------------------------------------
	const rank0TrailFactor = 1.0;
	const rank1TrailFactor = 0.9;
	const rank2TrailFactor = 0.5;
	const rank3TrailFactor = 0.3;

	const useHardSnap = true;
	const leadingSnapFactor = 0.1;
	const leadingSnapThreshold = 0.5;
	const animationResetThreshold = 0.075;
	const maxTrailDistanceFactor = 100;
	const snapAnimationLength = 0.02;

	// ------------------------------------------------------------------
	// Global cursor management
	// ------------------------------------------------------------------
	const cursorUpdatePollingRate = 100;
	const cursorDisappearDelay = 40;
	const cursorFadeOutDuration = 0.06;

	const canvasFadeTransitionCss = `opacity ${cursorFadeOutDuration}s ease-out`;
	const nativeCursorDisappearTransitionCss = "opacity 0s ease-out";
	const nativeCursorRevealTransitionCss = "opacity 0.06s ease-in";

	const terminalAnimatingClass = "bettervsc-terminal-animating";

	const globalCursorState = {
		lastX: null,
		lastY: null,
		lastWidth: null,
		lastHeight: null,
		lastUpdated: 0,
		lastKind: null,
	};

	// ------------------------------------------------------------------
	// Utilities
	// ------------------------------------------------------------------
	const resolveColor = (hex) => {
		let h = hex.startsWith("#") ? hex.slice(1).toUpperCase() : hex.toUpperCase();
		if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
		if (h.length === 6) h += "FF";
		const r = parseInt(h.slice(0, 2), 16) >> 0;
		const g = parseInt(h.slice(2, 4), 16) >> 0;
		const b = parseInt(h.slice(4, 6), 16) >> 0;
		const a = parseInt(h.slice(6, 8), 16) >> 0;
		return { r, g, b, a };
	};

	const rgbaToCss = ({ r, g, b, a }) => `rgba(${r}, ${g}, ${b}, ${a / 255})`;

	const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

	const normalize = (v) => {
		const l = Math.hypot(v.x, v.y);
		return l ? { x: v.x / l, y: v.y / l } : { x: 0, y: 0 };
	};

	// Corners in the cursor's local coordinate system (centre at 0, 0).
	const cursorRelativeCorners = [
		{ x: -0.5, y: -0.5 },
		{ x: 0.5, y: -0.5 },
		{ x: 0.5, y: 0.5 },
		{ x: -0.5, y: 0.5 },
	];

	// ------------------------------------------------------------------
	// Critically damped spring
	// ------------------------------------------------------------------
	class DampedSpringAnimation {
		constructor(length) {
			this.position = 0;
			this.velocity = 0;
			this.animationLength = length;
		}

		update(dt) {
			if (this.animationLength <= dt || Math.abs(this.position) < 0.001) {
				this.reset();
				return false;
			}

			const o = 4.0 / this.animationLength;
			const a = this.position;
			const b = this.position * o + this.velocity;
			const c = Math.exp(-o * dt);

			this.position = (a + b * dt) * c;
			this.velocity = c * (-a * o - b * dt * o + b);

			return Math.abs(this.position) >= 0.01;
		}

		reset() {
			this.position = 0;
			this.velocity = 0;
		}
	}

	// ------------------------------------------------------------------
	// Corner spring
	// ------------------------------------------------------------------
	class Corner {
		constructor(relativePosition) {
			this.rp = relativePosition;
			this.cp = { x: 0, y: 0 };
			this.pd = { x: -1e5, y: -1e5 };
			this.ax = new DampedSpringAnimation(animationLength);
			this.ay = new DampedSpringAnimation(animationLength);
			this.targetDim = { width: 8, height: 18 };
		}

		getDest(center, dim) {
			return {
				x: center.x + this.rp.x * dim.width,
				y: center.y + this.rp.y * dim.height,
			};
		}

		calculateDirectionAlignment(dim, destCenter) {
			const cornerDest = this.getDest(destCenter, dim);
			const travelDir = normalize({
				x: cornerDest.x - this.cp.x,
				y: cornerDest.y - this.cp.y,
			});
			const cornerDir = normalize(this.rp);
			return travelDir.x * cornerDir.x + travelDir.y * cornerDir.y;
		}

		jump(center, dim, rank, baseTimeOverride = null) {
			this.targetDim = { ...dim };
			const target = this.getDest(center, dim);
			const jumpVector = {
				x: (target.x - this.pd.x) / dim.width,
				y: (target.y - this.pd.y) / dim.height,
			};

			const isShortMove =
				Math.abs(jumpVector.x) <= shortMoveThreshold &&
				Math.abs(jumpVector.y) <= 0.001;
			const baseTime =
				baseTimeOverride ||
				(isShortMove ? shortAnimationLength : animationLength);
			const leadingAlignment =
				normalize(jumpVector).x * normalize(this.rp).x +
				normalize(jumpVector).y * normalize(this.rp).y;

			let finalFactor;
			if (useHardSnap && leadingAlignment > leadingSnapThreshold) {
				finalFactor = leadingSnapFactor;
			} else {
				const factors = [
					rank0TrailFactor,
					rank1TrailFactor,
					rank2TrailFactor,
					rank3TrailFactor,
				];
				finalFactor = factors[rank] || 1.0;
			}

			const length =
				leadingAlignment > leadingSnapThreshold && useHardSnap
					? snapAnimationLength
					: baseTime * clamp(finalFactor, 0, 1);

			this.ax.animationLength = length;
			this.ay.animationLength = length;

			if (length > animationResetThreshold) {
				this.ax.reset();
				this.ay.reset();
			}
		}

		update(dim, center, dt, immediate) {
			const dest = this.getDest(center, dim);

			if (dest.x !== this.pd.x || dest.y !== this.pd.y) {
				this.ax.position = dest.x - this.cp.x;
				this.ay.position = dest.y - this.cp.y;
				this.pd = { ...dest };
			}

			if (immediate) {
				this.cp = dest;
				this.ax.reset();
				this.ay.reset();
				return false;
			}

			this.ax.update(dt);
			this.ay.update(dt);

			const maxD = Math.max(dim.width, dim.height) * maxTrailDistanceFactor;
			this.ax.position = clamp(this.ax.position, -maxD, maxD);
			this.ay.position = clamp(this.ay.position, -maxD, maxD);

			this.cp.x = dest.x - this.ax.position;
			this.cp.y = dest.y - this.ay.position;

			return (
				Math.abs(this.ax.position) > 0.5 || Math.abs(this.ay.position) > 0.5
			);
		}
	}

	// ------------------------------------------------------------------
	// Cursor renderer
	// ------------------------------------------------------------------
	const createNeovideCursor = ({
		canvas,
		fillOpacity = tailOpacity,
		shadowBlurPx = null,
		stroke = false,
		useSourceDimensions = false,
		kind = "editor",
	}) => {
		let useSource = useSourceDimensions;
		const toRgbaCss = (hex, alphaScale = fillOpacity) => {
			const colorObj = resolveColor(hex);
			return rgbaToCss({
				...colorObj,
				a: (colorObj.a * alphaScale) >> 0,
			});
		};

		let finalColorCss = toRgbaCss(currentCursorColor());
		let shadowColorCss = useShadow
			? toRgbaCss(currentCursorColor(), Math.min(1, fillOpacity * 2))
			: null;
		let strokeColorCss = stroke
			? toRgbaCss(currentCursorColor(), TREE_STROKE_OPACITY)
			: null;

		const context = canvas.getContext("2d");
		let cursorDimensions = { width: 8, height: 18 };
		let centerDest = { x: 0, y: 0 };
		let lastT = performance.now();
		let initialized = false;
		let jumped = false;
		let drawAlpha = 1;
		let fadeStart = null;
		let fadeFrom = 1;
		let fadeDuration = 200;
		let fadeOnSource = false;
		let moveDuration = animationLength;

		const corners = cursorRelativeCorners.map((p) => new Corner(p));

		return {
			setColor: (hex) => {
				const next = toRgbaCss(hex);
				if (next === finalColorCss) return;
				finalColorCss = next;
				shadowColorCss = useShadow
					? toRgbaCss(hex, Math.min(1, fillOpacity * 2))
					: null;
				strokeColorCss = stroke
					? toRgbaCss(hex, TREE_STROKE_OPACITY)
					: null;
			},

			setMoveDuration: (seconds) => {
				moveDuration = seconds;
			},

			enableTreeTransition: () => {
				useSource = true;
				fadeOnSource = true;
				moveDuration = 0.23;
				drawAlpha = TREE_OVERLAY_OPACITY;
				fadeFrom = TREE_OVERLAY_OPACITY;
				fadeStart = null;
				fadeDuration = 280;
			},

			getDebug: () => ({
				alpha: drawAlpha,
				useSource,
				fading: fadeStart !== null,
				corners: corners.map((c) => ({ x: c.cp.x, y: c.cp.y })),
				size: { ...cursorDimensions },
				center: { ...centerDest },
			}),

			startFadeIn: (fromAlpha, durationMs) => {
				drawAlpha = fromAlpha;
				fadeFrom = fromAlpha;
				fadeStart = performance.now();
				fadeDuration = durationMs;
			},

			move: (x, y, fromSource = null, updateGlobal = true) => {
				if ((x <= 0 && y <= 0) || isNaN(x) || isNaN(y)) return;

				const newCenter = {
					x: x + cursorDimensions.width / 2,
					y: y + cursorDimensions.height / 2,
				};

				if (!initialized || fromSource) {
					const src =
						fromSource ||
						(globalCursorState.lastX !== null
							? { x: globalCursorState.lastX, y: globalCursorState.lastY }
							: null);

					if (src) {
						const oldDim = useSource
							? {
									width:
										globalCursorState.lastWidth || cursorDimensions.width,
									height:
										globalCursorState.lastHeight || cursorDimensions.height,
								}
							: { ...cursorDimensions };
						corners.forEach((c) => {
							c.targetDim = { ...oldDim };
							const d = c.getDest({ x: src.x, y: src.y }, oldDim);
							c.cp = { ...d };
							c.pd = { ...d };
						});
					} else {
						corners.forEach((c) => {
							c.targetDim = { ...cursorDimensions };
							const d = c.getDest(newCenter, cursorDimensions);
							c.cp = { ...d };
							c.pd = { ...d };
						});
					}
					initialized = true;
				}

				if (fromSource && fadeOnSource) {
					fadeOnSource = false;
					drawAlpha = TREE_OVERLAY_OPACITY;
					fadeFrom = TREE_OVERLAY_OPACITY;
					fadeStart = performance.now();
					fadeDuration = 280;
				}

				centerDest = newCenter;
				jumped = true;

				if (updateGlobal) {
					globalCursorState.lastX = newCenter.x;
					globalCursorState.lastY = newCenter.y;
					globalCursorState.lastWidth = cursorDimensions.width;
					globalCursorState.lastHeight = cursorDimensions.height;
					globalCursorState.lastUpdated = Date.now();
					globalCursorState.lastKind = kind;
				}
			},

			updateSize: (w, h) => {
				if (w > 0 && h > 0) {
					cursorDimensions.width = w;
					cursorDimensions.height = h;
				}
			},

			updateLoop: (isScrolling, draw) => {
				if (!initialized) return false;

				const now = performance.now();
				const dt = Math.min((now - lastT) / 1000, 1 / 30);
				lastT = now;

				let fading = false;
				if (fadeStart !== null) {
					const t = Math.min(1, (now - fadeStart) / fadeDuration);
					drawAlpha = fadeFrom + (1 - fadeFrom) * t;
					if (t >= 1) {
						fadeStart = null;
						drawAlpha = 1;
					} else {
						fading = true;
					}
				}

				if (jumped) {
					const ranks = corners
						.map((c, i) => ({
							i,
							v: c.calculateDirectionAlignment(cursorDimensions, centerDest),
						}))
						.sort((a, b) => a.v - b.v)
						.map((it, rank) => ({ i: it.i, r: rank }))
						.reduce((acc, cur) => {
							acc[cur.i] = cur.r;
							return acc;
						}, []);

					corners.forEach((c, i) =>
						c.jump(centerDest, cursorDimensions, ranks[i], moveDuration)
					);
					jumped = false;
				}

				let animating = false;
				corners.forEach((c) => {
					if (c.update(cursorDimensions, centerDest, dt, isScrolling)) {
						animating = true;
					}
				});

				if (draw) {
					context.globalAlpha = drawAlpha;
					context.beginPath();
					context.moveTo(corners[0].cp.x, corners[0].cp.y);
					for (let i = 1; i < 4; i++) {
						context.lineTo(corners[i].cp.x, corners[i].cp.y);
					}
					context.closePath();
					context.fillStyle = finalColorCss;

					if (useShadow) {
						context.shadowColor = shadowColorCss;
						context.shadowBlur =
							shadowBlurPx !== null
								? shadowBlurPx
								: shadowBlurFactor *
								  Math.max(cursorDimensions.width, cursorDimensions.height);
					}

					context.fill();
					context.shadowBlur = 0;
					context.shadowColor = "transparent";

					if (stroke && strokeColorCss) {
						context.strokeStyle = strokeColorCss;
						context.lineWidth = 1.5;
						context.stroke();
					}

					context.globalAlpha = 1;
				}

				return animating || fading;
			},
		};
	};

	// ------------------------------------------------------------------
	// Manager
	// ------------------------------------------------------------------
	class GlobalCursorManager {
		constructor() {
			this.cursors = new Map();
			this.canvas = document.createElement("canvas");
			this.ctx = this.canvas.getContext("2d");
			this.isScrolling = false;
			this.init();
		}

		lastSource() {
			return globalCursorState.lastX !== null
				? { x: globalCursorState.lastX, y: globalCursorState.lastY }
				: null;
		}

		init() {
			const style = document.createElement("style");
			style.textContent = `
				:root {
					--bettervsc-cursor-color: ${currentCursorColor()};
					--bettervsc-cursor-color-soft: ${softCursorColorCss()};
				}
				.monaco-editor .cursor {
					transition: none !important;
				}
				.monaco-editor .cursors-layer > .cursor {
					background-color: var(--bettervsc-cursor-color) !important;
				}
				.monaco-editor .cursors-layer.cursor-block-outline-style > .cursor {
					border-color: var(--bettervsc-cursor-color) !important;
				}
				.monaco-editor .cursors-layer.cursor-underline-style > .cursor,
				.monaco-editor .cursors-layer.cursor-underline-thin-style > .cursor {
					border-bottom-color: var(--bettervsc-cursor-color) !important;
				}
				.monaco-editor .inputarea.ime-input {
					caret-color: var(--bettervsc-cursor-color) !important;
				}
				.cursor-trail {
					opacity: 0 !important;
				}
				.xterm.${terminalAnimatingClass} .xterm-cursor {
					opacity: 0 !important;
				}
				body .monaco-workbench .xterm .xterm-rows .xterm-cursor.xterm-cursor-block,
				body .monaco-workbench .xterm .xterm-rows .xterm-cursor.xterm-cursor-block:not(.xterm-cursor-blink),
				body .monaco-workbench .xterm .xterm-rows.xterm-focus .xterm-cursor.xterm-cursor-blink.xterm-cursor-block {
					background-color: var(--bettervsc-cursor-color) !important;
					color: ${CURSOR_ACCENT} !important;
				}
				body .monaco-workbench .xterm .xterm-rows .xterm-cursor.xterm-cursor-outline {
					outline-color: var(--bettervsc-cursor-color) !important;
				}
				body .monaco-workbench .xterm .xterm-rows .xterm-cursor.xterm-cursor-underline {
					border-bottom-color: var(--bettervsc-cursor-color) !important;
				}
				body .monaco-workbench .explorer-viewlet .explorer-folders-view.file-icon-themable-tree .monaco-list:focus .monaco-list-row.focused,
				body .monaco-workbench .explorer-viewlet .customview-tree.file-icon-themable-tree .monaco-list:focus .monaco-list-row.focused {
					background-color: var(--bettervsc-cursor-color-soft) !important;
				}
			`;
			document.head.appendChild(style);
			document.documentElement.style.setProperty(
				"--bettervsc-cursor-color",
				currentCursorColor()
			);
			document.documentElement.style.setProperty(
				"--bettervsc-cursor-color-soft",
				softCursorColorCss()
			);

			this.canvas.style.cssText = `
				pointer-events: none;
				position: fixed;
				top: 0;
				left: 0;
				z-index: 9999;
				opacity: 0;
				transition: none;
			`;
			document.body.appendChild(this.canvas);

			const resize = () => {
				this.canvas.width = window.innerWidth;
				this.canvas.height = window.innerHeight;
			};
			window.addEventListener("resize", resize);
			resize();

			document.addEventListener(
				"scroll",
				() => {
					this.isScrolling = true;
					clearTimeout(this.scrollTimer);
					this.scrollTimer = setTimeout(() => {
						this.isScrolling = false;
					}, 100);
				},
				{ capture: true, passive: true }
			);

			document.addEventListener("focusin", () => this.scan(), true);
			document.addEventListener("focusout", () => this.scan(), true);

			this.setupImeDetection();

			this.loop();
			this.scan();
			setInterval(() => this.scan(), cursorUpdatePollingRate);
		}

		setupImeDetection() {
			let shiftDown = false;
			let shiftUsed = false;
			let probeTimer = null;

			const isEditingContext = () => {
				const active = document.activeElement;
				if (!active) return false;
				if (active.tagName === "INPUT" || active.tagName === "TEXTAREA") {
					return true;
				}
				if (typeof active.closest !== "function") return false;
				return !!(
					active.closest(".monaco-editor") ||
					active.closest(".xterm")
				);
			};

			const clearProbe = () => {
				if (probeTimer !== null) {
					clearTimeout(probeTimer);
					probeTimer = null;
				}
			};

			const markChinese = () => {
				clearProbe();
				setImeState("zh");
			};

			document.addEventListener("compositionstart", markChinese, true);
			document.addEventListener("compositionupdate", markChinese, true);
			document.addEventListener(
				"compositionend",
				() => {
					clearProbe();
					setImeState("zh");
				},
				true
			);

			document.addEventListener(
				"keydown",
				(event) => {
					if (event.key === "Shift") {
						shiftDown = true;
						shiftUsed = false;
						return;
					}

					if (shiftDown) shiftUsed = true;

					if (event.isComposing || event.keyCode === 229) {
						markChinese();
						return;
					}

					if (event.ctrlKey || event.altKey || event.metaKey) return;

					if (
						typeof event.key === "string" &&
						event.key.length === 1 &&
						/[a-zA-Z]/.test(event.key)
					) {
						clearProbe();
						probeTimer = setTimeout(() => {
							probeTimer = null;
							setImeState("en");
						}, 120);
					}
				},
				true
			);

			document.addEventListener(
				"keyup",
				(event) => {
					if (event.key !== "Shift") {
						if (shiftDown) shiftUsed = true;
						return;
					}

					const shouldToggle = shiftDown && !shiftUsed;
					shiftDown = false;
					shiftUsed = false;
					if (shouldToggle && isEditingContext()) toggleImeState();
				},
				true
			);

			document.addEventListener(
				"mousedown",
				() => {
					if (shiftDown) shiftUsed = true;
				},
				true
			);

			document.addEventListener(
				"wheel",
				() => {
					if (shiftDown) shiftUsed = true;
				},
				{ capture: true, passive: true }
			);
		}

		scan() {
			const ids = new Set();

			// Editor cursors
			document.querySelectorAll(".monaco-editor .cursor").forEach((el) => {
				let id = el.dataset.bettervscCursorId;
				if (!id) {
					id = "e" + Math.random().toString(36).slice(2, 9);
					el.dataset.bettervscCursorId = id;
				}
				ids.add(id);

				if (this.cursors.has(id)) return;

				const r = el.getBoundingClientRect();
				if (r.left > 0 || r.top > 0) {
					const editorRoot = el.closest(".monaco-editor");
					const editorFocused =
						!!editorRoot &&
						(editorRoot.contains(document.activeElement) ||
							editorRoot.classList.contains("focused"));
					const fromTree =
						editorFocused && globalCursorState.lastKind === "tree";
					const instance = createNeovideCursor({
						canvas: this.canvas,
						kind: "editor",
						useSourceDimensions: fromTree,
					});
					if (fromTree) instance.enableTreeTransition();
					instance.updateSize(r.width, r.height);
					if (editorFocused) {
						instance.move(r.left, r.top, this.lastSource());
					} else {
						instance.move(r.left, r.top, null, false);
					}
					this.cursors.set(id, {
						kind: "editor",
						instance,
						target: el,
						lastX: r.left,
						lastY: r.top,
						lastW: r.width,
						lastH: r.height,
						isActive: editorFocused,
						isJumping: false,
						jumpSource: null,
						isAnimating: false,
						ignoreScrollUntil: editorFocused ? Date.now() + 300 : 0,
					});
				}
			});

			// Terminal cursors: only the focused terminal.
			document.querySelectorAll(".xterm.focus").forEach((root) => {
				const cursorEl = root.querySelector(".xterm-cursor");
				if (!cursorEl) return;

				let id = root.dataset.bettervscCursorId;
				if (!id) {
					id = "t" + Math.random().toString(36).slice(2, 9);
					root.dataset.bettervscCursorId = id;
				}
				ids.add(id);

				if (this.cursors.has(id)) return;

				const r = cursorEl.getBoundingClientRect();
				if (r.width > 0 && r.height > 0) {
					const fromTree = globalCursorState.lastKind === "tree";
					const instance = createNeovideCursor({
						canvas: this.canvas,
						kind: "terminal",
						useSourceDimensions: fromTree,
					});
					if (fromTree) instance.enableTreeTransition();
					instance.updateSize(r.width, r.height);
					instance.move(r.left, r.top, this.lastSource());
					this.cursors.set(id, {
						kind: "terminal",
						instance,
						root,
						lastX: r.left,
						lastY: r.top,
						lastW: r.width,
						lastH: r.height,
						isActive: true,
						isJumping: false,
						jumpSource: null,
						isAnimating: false,
						ignoreScrollUntil: Date.now() + 300,
					});
				}
			});

			// Explorer file tree: follow the focused row.
			document
				.querySelectorAll(
					".explorer-viewlet .explorer-folders-view.file-icon-themable-tree, .explorer-viewlet .customview-tree.file-icon-themable-tree"
				)
				.forEach((container) => {
					const root = container.querySelector(".monaco-list") || container;
					const active = document.activeElement;
					const hasFocus =
						root === active || (active && root.contains(active));
					if (!hasFocus) return;
					if (
						active &&
						(active.tagName === "INPUT" || active.tagName === "TEXTAREA")
					) {
						return;
					}

					const row = root.querySelector(".monaco-list-row.focused");
					if (!row) return;

					let id = root.dataset.bettervscTreeId;
					if (!id) {
						id = "r" + Math.random().toString(36).slice(2, 9);
						root.dataset.bettervscTreeId = id;
					}
					ids.add(id);

					if (this.cursors.has(id)) return;

					const r = row.getBoundingClientRect();
					if (r.width > 0 && r.height > 0) {
						const instance = createNeovideCursor({
							canvas: this.canvas,
							kind: "tree",
							fillOpacity: TREE_OVERLAY_OPACITY,
							shadowBlurPx: TREE_SHADOW_BLUR,
							stroke: true,
							useSourceDimensions: true,
						});
						instance.setMoveDuration(0.15);
						instance.updateSize(r.width, r.height);
						instance.move(r.left, r.top, this.lastSource());
						this.cursors.set(id, {
							kind: "tree",
							instance,
							root,
							lastX: r.left,
							lastY: r.top,
							lastW: r.width,
							lastH: r.height,
							isActive: true,
							isJumping: false,
							jumpSource: null,
							isAnimating: false,
							ignoreScrollUntil: Date.now() + 300,
						});
					}
				});

			for (const [id, data] of this.cursors) {
				if (ids.has(id)) continue;
				if (data.kind === "terminal" && data.root) {
					data.root.classList.remove(terminalAnimatingClass);
				}
				this.cursors.delete(id);
			}
		}

		resolveTarget(data) {
			if (data.kind === "terminal") {
				if (!data.root || !data.root.isConnected) return null;
				return data.root.querySelector(".xterm-cursor");
			}
			if (data.kind === "tree") {
				if (!data.root || !data.root.isConnected) return null;
				return data.root.querySelector(".monaco-list-row.focused");
			}
			return data.target && data.target.isConnected ? data.target : null;
		}

		loop() {
			this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
			let isAnyAnimating = false;
			const color = currentCursorColor();

			for (const data of this.cursors.values()) {
				const el = this.resolveTarget(data);

				if (!el) {
					if (data.kind === "terminal" && data.root) {
						data.root.classList.remove(terminalAnimatingClass);
					}
					data.isActive = false;
					data.isAnimating = false;
					continue;
				}

				if (data.instanceColor !== color) {
					data.instance.setColor(color);
					data.instanceColor = color;
				}

				const r = el.getBoundingClientRect();
				let isNowActive;

				if (data.kind === "terminal") {
					const rootRect = data.root.getBoundingClientRect();
					isNowActive =
						data.root.classList.contains("focus") &&
						r.width > 0 &&
						r.height > 0 &&
						rootRect.width > 0 &&
						rootRect.height > 0;
				} else if (data.kind === "tree") {
					const active = document.activeElement;
					const rootRect = data.root.getBoundingClientRect();
					isNowActive =
						(data.root === active ||
							(active && data.root.contains(active))) &&
						!(active &&
							(active.tagName === "INPUT" ||
								active.tagName === "TEXTAREA")) &&
						r.width > 0 &&
						r.height > 0 &&
						rootRect.width > 0 &&
						rootRect.height > 0 &&
						r.top >= rootRect.top - 1 &&
						r.bottom <= rootRect.bottom + 1;
				} else {
					const style = getComputedStyle(el);
					const editorRoot = el.closest(".monaco-editor");
					const editorFocused =
						!!editorRoot &&
						(editorRoot.contains(document.activeElement) ||
							editorRoot.classList.contains("focused"));
					isNowActive =
						editorFocused &&
						style.visibility !== "hidden" &&
						style.display !== "none" &&
						!style.transform.includes("-10000px");
				}

				const changed =
					Math.abs(r.left - data.lastX) > 0.01 ||
					Math.abs(r.top - data.lastY) > 0.01 ||
					Math.abs(r.width - data.lastW) > 0.01 ||
					Math.abs(r.height - data.lastH) > 0.01;

				if (isNowActive && !data.isActive) {
					data.isJumping = true;
					data.jumpSource = this.lastSource();
					data.ignoreScrollUntil = Date.now() + 300;
					if (
						(data.kind === "editor" || data.kind === "terminal") &&
						globalCursorState.lastKind === "tree"
					) {
						data.instance.enableTreeTransition();
					}
				}

				if (data.isJumping && (changed || isNowActive)) {
					data.instance.updateSize(r.width, r.height);
					data.instance.move(r.left, r.top, data.jumpSource);
					data.isJumping = false;
					data.lastX = r.left;
					data.lastY = r.top;
					data.lastW = r.width;
					data.lastH = r.height;
				} else if (isNowActive && changed) {
					data.instance.updateSize(r.width, r.height);
					data.instance.move(r.left, r.top);
					data.lastX = r.left;
					data.lastY = r.top;
					data.lastW = r.width;
					data.lastH = r.height;
				} else if (isNowActive) {
					data.instance.updateSize(r.width, r.height);
				}

				data.isActive = isNowActive;

				if (
					!isNowActive &&
					data.kind === "editor" &&
					data.target &&
					data.target.style.opacity === "0"
				) {
					data.target.style.opacity = "1";
				}

				if (isNowActive) {
					const scrolling =
						this.isScrolling && Date.now() > (data.ignoreScrollUntil || 0);
					const animating = data.instance.updateLoop(
						scrolling,
						r.left >= 0 && r.top >= 0 && r.left <= window.innerWidth
					);
					if (animating) isAnyAnimating = true;
					data.isAnimating = animating;
				} else {
					data.isAnimating = false;
				}
			}

			if (isAnyAnimating) {
				this.canvas.style.transition = "none";
				this.canvas.style.opacity = "1";

				for (const data of this.cursors.values()) {
					if (!data.isActive) continue;
					if (data.kind === "editor" && data.target) {
						data.target.style.transition = nativeCursorDisappearTransitionCss;
						data.target.style.opacity = "0";
					} else if (data.kind === "terminal" && data.root) {
						data.root.classList.add(terminalAnimatingClass);
					}
				}
			} else {
				if (this.canvas.style.opacity === "1") {
					setTimeout(() => {
						if (this.canvas.style.opacity === "1") {
							this.canvas.style.transition = canvasFadeTransitionCss;
							this.canvas.style.opacity = "0";
						}
					}, cursorDisappearDelay);
				}

				for (const data of this.cursors.values()) {
					if (data.kind === "editor" && data.isActive && data.target) {
						data.target.style.transition = nativeCursorRevealTransitionCss;
						data.target.style.opacity = "1";
					} else if (data.kind === "terminal" && data.root) {
						data.root.classList.remove(terminalAnimatingClass);
					}
				}
			}

			requestAnimationFrame(() => this.loop());
		}
	}

	const start = () => {
		if (!document.body) {
			setTimeout(start, 50);
			return;
		}
		window.__betterVSCNeovideCursor = new GlobalCursorManager();
	};

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", start, { once: true });
	} else {
		start();
	}
})();
