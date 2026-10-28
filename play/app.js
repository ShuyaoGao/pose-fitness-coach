(function() {
	//#region src/landmarks.js
	/**
	* MediaPipe Pose Landmarker（BlazePose）输出 33 个关键点。
	* 这里把我们会用到的关键点下标取个有意义的名字，避免代码里到处写 magic number。
	*
	* 完整 33 点定义见官方文档：
	* https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker
	*
	* 坐标说明：每个关键点是 { x, y, z, visibility }
	*   - x, y：归一化到 [0,1] 的图像坐标（左上角为原点，x 向右，y 向下）。
	*   - z：相对深度（越小越靠近摄像头），单 RGB 摄像头下不太准，MVP 基本不用。
	*   - visibility：该点可见/可信度 [0,1]，被遮挡时会变低。
	*/
	var POSE = {
		NOSE: 0,
		LEFT_SHOULDER: 11,
		RIGHT_SHOULDER: 12,
		LEFT_ELBOW: 13,
		RIGHT_ELBOW: 14,
		LEFT_WRIST: 15,
		RIGHT_WRIST: 16,
		LEFT_HIP: 23,
		RIGHT_HIP: 24,
		LEFT_KNEE: 25,
		RIGHT_KNEE: 26,
		LEFT_ANKLE: 27,
		RIGHT_ANKLE: 28
	};
	//#endregion
	//#region src/geometry.js
	/**
	* 纯几何工具：用关键点坐标算关节角度、距离等。
	* 这部分不依赖任何库——拿到坐标后全是中学向量几何，是本项目「原创规则」的基础。
	*
	* 每个点都是 { x, y, (z), visibility } 形式（来自 MediaPipe 关键点）。
	*/
	/** 把数值限制在 [min, max] 区间内。 */
	function clamp(value, min, max) {
		return Math.min(Math.max(value, min), max);
	}
	/**
	* 计算「以 b 为顶点，由 a-b-c 三点构成的夹角」，返回角度（0~180°）。
	* 例：算膝关节角度就传 (髋, 膝, 踝)。
	*
	* 原理：求向量 ba 和 bc 的夹角，cosθ = (ba·bc) / (|ba|·|bc|)。
	* 只用 x、y（图像平面），对「正对/侧对摄像头的标准动作」足够稳。
	*/
	function angleAt(a, b, c) {
		const baX = a.x - b.x;
		const baY = a.y - b.y;
		const bcX = c.x - b.x;
		const bcY = c.y - b.y;
		const dot = baX * bcX + baY * bcY;
		const magBa = Math.hypot(baX, baY);
		const magBc = Math.hypot(bcX, bcY);
		if (magBa === 0 || magBc === 0) return 0;
		const cos = clamp(dot / (magBa * magBc), -1, 1);
		return Math.acos(cos) * 180 / Math.PI;
	}
	/** 两点在图像平面上的水平距离（只看 x）。用于判断「膝盖间距 / 踝间距」。 */
	function horizontalDistance(p1, p2) {
		return Math.abs(p1.x - p2.x);
	}
	/**
	* 判断一组关键点是否都「足够可见」。
	* MediaPipe 给每个点一个 visibility，被遮挡/出画面时会变低。
	* 关键点不可信时，我们宁可不计数、不判错，也不要误判。
	*/
	function allVisible(landmarks, indices, threshold = .5) {
		return indices.every((i) => {
			const lm = landmarks[i];
			return lm && (lm.visibility ?? 0) >= threshold;
		});
	}
	/**
	* 默认阈值（与上面的常量一一对应）。createSquatExercise(overrides) 可以覆盖其中任意几项，
	* 用于网页上的「判定严格度」预设和细调滑块；不传参数时行为与原来完全一致。
	*/
	var SQUAT_DEFAULTS = Object.freeze({
		standAngle: 170,
		deepTarget: 90,
		upAngle: 160,
		downAngle: 130,
		shallowAngle: 105,
		valgusRatio: .55
	});
	var REQUIRED$1 = [
		POSE.LEFT_HIP,
		POSE.RIGHT_HIP,
		POSE.LEFT_KNEE,
		POSE.RIGHT_KNEE,
		POSE.LEFT_ANKLE,
		POSE.RIGHT_ANKLE
	];
	/**
	* 深蹲涉及的主要肌群，按「前视图 / 后视图」分开（body-muscles 的肌肉分属两个视图）。
	* weight 是相对发力权重（0~1），main.js 据此把「蹲的深度」映射成肌肉高亮强度。
	*/
	var SQUAT_MUSCLES = {
		front: [
			{
				id: "quads-left",
				weight: 1
			},
			{
				id: "quads-right",
				weight: 1
			},
			{
				id: "adductors-left",
				weight: .6
			},
			{
				id: "adductors-right",
				weight: .6
			}
		],
		back: [
			{
				id: "gluteus-maximus-left",
				weight: 1
			},
			{
				id: "gluteus-maximus-right",
				weight: 1
			},
			{
				id: "hamstrings-medial-left",
				weight: .7
			},
			{
				id: "hamstrings-lateral-left",
				weight: .7
			},
			{
				id: "hamstrings-medial-right",
				weight: .7
			},
			{
				id: "hamstrings-lateral-right",
				weight: .7
			},
			{
				id: "lower-back-erectors-left",
				weight: .4
			},
			{
				id: "lower-back-erectors-right",
				weight: .4
			},
			{
				id: "calves-gastroc-medial-left",
				weight: .3
			},
			{
				id: "calves-gastroc-medial-right",
				weight: .3
			}
		]
	};
	function createSquatExercise(overrides = {}) {
		const T = {
			...SQUAT_DEFAULTS,
			...overrides
		};
		const { standAngle, deepTarget, upAngle, downAngle, shallowAngle, valgusRatio: valgusLimit } = T;
		let phase = "up";
		let count = 0;
		let repMinKneeAngle = 180;
		let repMinValgusRatio = 2;
		function resetRepTrackers() {
			repMinKneeAngle = 180;
			repMinValgusRatio = 2;
		}
		function reset() {
			phase = "up";
			count = 0;
			resetRepTrackers();
		}
		/**
		* 每帧调用一次。
		* @param {Array} landmarks 33 个归一化关键点（result.landmarks[0]）
		* @returns 结构化结果（见文件顶部说明）
		*/
		function update(landmarks) {
			if (!landmarks || !allVisible(landmarks, REQUIRED$1)) return {
				ready: false,
				count,
				phase,
				phaseLabel: phase === "down" ? "下蹲" : "站立",
				repCompleted: false,
				kneeAngle: null,
				metricText: null,
				depthRatio: 0,
				lastRep: null
			};
			const kneeAngle = (angleAt(landmarks[POSE.LEFT_HIP], landmarks[POSE.LEFT_KNEE], landmarks[POSE.LEFT_ANKLE]) + angleAt(landmarks[POSE.RIGHT_HIP], landmarks[POSE.RIGHT_KNEE], landmarks[POSE.RIGHT_ANKLE])) / 2;
			const kneeWidth = horizontalDistance(landmarks[POSE.LEFT_KNEE], landmarks[POSE.RIGHT_KNEE]);
			const ankleWidth = horizontalDistance(landmarks[POSE.LEFT_ANKLE], landmarks[POSE.RIGHT_ANKLE]);
			const valgusRatio = ankleWidth > .001 ? kneeWidth / ankleWidth : 2;
			const depthRatio = clamp01$2((standAngle - kneeAngle) / (standAngle - deepTarget));
			if (phase === "down") {
				repMinKneeAngle = Math.min(repMinKneeAngle, kneeAngle);
				repMinValgusRatio = Math.min(repMinValgusRatio, valgusRatio);
			}
			let repCompleted = false;
			let lastRep = null;
			if (phase === "up" && kneeAngle < downAngle) {
				phase = "down";
				resetRepTrackers();
				repMinKneeAngle = kneeAngle;
				repMinValgusRatio = valgusRatio;
			} else if (phase === "down" && kneeAngle > upAngle) {
				phase = "up";
				count += 1;
				repCompleted = true;
				const cues = [];
				if (repMinKneeAngle > shallowAngle) cues.push("shallow");
				if (repMinValgusRatio < valgusLimit) cues.push("valgus");
				lastRep = {
					index: count,
					minKneeAngle: Math.round(repMinKneeAngle),
					minValgusRatio: Number(repMinValgusRatio.toFixed(2)),
					metric: Math.round(repMinKneeAngle),
					cues,
					good: cues.length === 0
				};
			}
			return {
				ready: true,
				count,
				phase,
				phaseLabel: phase === "down" ? "下蹲" : "站立",
				repCompleted,
				kneeAngle: Math.round(kneeAngle),
				metricText: `${Math.round(kneeAngle)}°`,
				depthRatio,
				lastRep,
				metricValue: kneeAngle,
				valgusRatio,
				repMinKneeAngle: phase === "down" ? repMinKneeAngle : null,
				repMinValgusRatio: phase === "down" ? repMinValgusRatio : null
			};
		}
		return {
			id: "squat",
			name: "深蹲",
			instructions: "正对摄像头站好，露出从头到脚，双脚与肩同宽，缓慢下蹲再站起。",
			metricLabel: "膝关节角度",
			repMetricLabel: "最低膝角(°)",
			muscleGroups: SQUAT_MUSCLES,
			thresholds: T,
			required: REQUIRED$1,
			update,
			reset
		};
	}
	function clamp01$2(v) {
		return Math.min(Math.max(v, 0), 1);
	}
	/**
	* 默认阈值（与上面的常量一一对应）。createJumpingJackExercise(overrides) 可以覆盖其中任意几项，
	* 用于网页上的「判定严格度」预设和细调滑块；不传参数时行为与原来完全一致。
	*/
	var JUMPING_JACK_DEFAULTS = Object.freeze({
		openRatio: 1.3,
		closeRatio: 1,
		fullSpread: 1.6,
		spreadRest: .6,
		spreadMax: 1.9
	});
	var REQUIRED = [
		POSE.NOSE,
		POSE.LEFT_SHOULDER,
		POSE.RIGHT_SHOULDER,
		POSE.LEFT_WRIST,
		POSE.RIGHT_WRIST,
		POSE.LEFT_ANKLE,
		POSE.RIGHT_ANKLE
	];
	/**
	* 开合跳涉及的主要肌群（id 来自 body-muscles，前/后视图分开）。
	* 主发力：三角肌（举臂）、臀中肌（髋外展）、腓肠肌（蹬跳）。
	*/
	var JUMPING_JACK_MUSCLES = {
		front: [
			{
				id: "shoulder-side-left",
				weight: 1
			},
			{
				id: "shoulder-side-right",
				weight: 1
			},
			{
				id: "shoulder-front-left",
				weight: .7
			},
			{
				id: "shoulder-front-right",
				weight: .7
			},
			{
				id: "adductors-left",
				weight: .5
			},
			{
				id: "adductors-right",
				weight: .5
			},
			{
				id: "tibialis-anterior-left",
				weight: .3
			},
			{
				id: "tibialis-anterior-right",
				weight: .3
			}
		],
		back: [
			{
				id: "gluteus-medius-left",
				weight: .9
			},
			{
				id: "gluteus-medius-right",
				weight: .9
			},
			{
				id: "calves-gastroc-medial-left",
				weight: .8
			},
			{
				id: "calves-gastroc-medial-right",
				weight: .8
			},
			{
				id: "deltoid-rear-left",
				weight: .6
			},
			{
				id: "deltoid-rear-right",
				weight: .6
			},
			{
				id: "traps-upper-left",
				weight: .4
			},
			{
				id: "traps-upper-right",
				weight: .4
			}
		]
	};
	function createJumpingJackExercise(overrides = {}) {
		const T = {
			...JUMPING_JACK_DEFAULTS,
			...overrides
		};
		const { openRatio, closeRatio, fullSpread, spreadRest, spreadMax } = T;
		let phase = "closed";
		let count = 0;
		let repMaxSpread = 0;
		let repArmsUpSeen = false;
		function resetRepTrackers() {
			repMaxSpread = 0;
			repArmsUpSeen = false;
		}
		function reset() {
			phase = "closed";
			count = 0;
			resetRepTrackers();
		}
		/**
		* 每帧调用一次。
		* @param {Array} landmarks 33 个归一化关键点（result.landmarks[0]）
		* @returns 结构化结果，字段约定同 squat.js（ready/count/phase/repCompleted/depthRatio/lastRep…）
		*/
		function update(landmarks) {
			if (!landmarks || !allVisible(landmarks, REQUIRED)) return {
				ready: false,
				count,
				phase,
				phaseLabel: phase === "open" ? "张开" : "并拢",
				repCompleted: false,
				spreadRatio: null,
				metricText: null,
				depthRatio: 0,
				lastRep: null
			};
			const shoulderWidth = horizontalDistance(landmarks[POSE.LEFT_SHOULDER], landmarks[POSE.RIGHT_SHOULDER]);
			const ankleWidth = horizontalDistance(landmarks[POSE.LEFT_ANKLE], landmarks[POSE.RIGHT_ANKLE]);
			const spread = shoulderWidth > .001 ? ankleWidth / shoulderWidth : 0;
			const nose = landmarks[POSE.NOSE];
			const armsUp = landmarks[POSE.LEFT_WRIST].y < nose.y && landmarks[POSE.RIGHT_WRIST].y < nose.y;
			const depthRatio = clamp01$1((spread - spreadRest) / (spreadMax - spreadRest));
			if (phase === "open") {
				repMaxSpread = Math.max(repMaxSpread, spread);
				if (armsUp) repArmsUpSeen = true;
			}
			let repCompleted = false;
			let lastRep = null;
			if (phase === "closed" && spread > openRatio) {
				phase = "open";
				resetRepTrackers();
				repMaxSpread = spread;
				repArmsUpSeen = armsUp;
			} else if (phase === "open" && spread < closeRatio) {
				phase = "closed";
				count += 1;
				repCompleted = true;
				const cues = [];
				if (!repArmsUpSeen) cues.push("arms_low");
				if (repMaxSpread < fullSpread) cues.push("narrow");
				lastRep = {
					index: count,
					maxSpread: Number(repMaxSpread.toFixed(2)),
					armsUp: repArmsUpSeen,
					metric: Number(repMaxSpread.toFixed(2)),
					cues,
					good: cues.length === 0
				};
			}
			return {
				ready: true,
				count,
				phase,
				phaseLabel: phase === "open" ? "张开" : "并拢",
				repCompleted,
				spreadRatio: Number(spread.toFixed(2)),
				metricText: `${spread.toFixed(2)}×`,
				depthRatio,
				lastRep,
				metricValue: spread,
				armsUp,
				repMaxSpread: phase === "open" ? repMaxSpread : null,
				repArmsUpSeen: phase === "open" ? repArmsUpSeen : null
			};
		}
		return {
			id: "jumpingJack",
			name: "开合跳",
			instructions: "正对摄像头露出全身，双脚并拢站好；跳开双脚的同时双手举过头顶，再跳回并拢。",
			metricLabel: "踝距/肩宽",
			repMetricLabel: "张开峰值(踝距/肩宽)",
			muscleGroups: JUMPING_JACK_MUSCLES,
			thresholds: T,
			required: REQUIRED,
			update,
			reset
		};
	}
	function clamp01$1(v) {
		return Math.min(Math.max(v, 0), 1);
	}
	//#endregion
	//#region node_modules/body-muscles/dist/esm/types.js
	/**
	* Anatomical view direction for the body map
	* @enum
	*/
	var ViewSide;
	(function(ViewSide) {
		/** Anterior (front) view of the body */
		ViewSide["FRONT"] = "FRONT";
		/** Posterior (back) view of the body */
		ViewSide["BACK"] = "BACK";
	})(ViewSide || (ViewSide = {}));
	//#endregion
	//#region node_modules/body-muscles/dist/esm/data/muscles.front.js
	/**
	* Front (Anterior) view muscle definitions
	* All muscle paths with x < 35 in the SVG coordinate system
	*/
	var FRONT_MUSCLES = [
		{
			id: "head",
			name: "Head",
			view: ViewSide.FRONT,
			path: "m 11.671635,6.3585449 -0.0482,-2.59085 4.20648,-2.46806 4.42769,2.95361 -0.0405,1.94408 0.24197,-3.34467 -2.03129,-2.31103004 -2.84508,-0.51629 -2.20423,0.52915 -1.9363,2.63077004 z"
		},
		{
			id: "face",
			name: "Face",
			view: ViewSide.FRONT,
			path: "m 19.748825,6.7034949 0.0203,-2.20747 -3.96689,-2.7637 -3.74099,2.23559 -0.006,2.63528 -0.60741,0.0403 0.27408,1.82447 0.97635,0.33932 0.44244,2.1802901 1.82222,2.06556 2.03518,-0.0607 1.79223,-1.94408 0.35957,-2.2406601 0.97616,-0.33932 0.25159,-1.78416 z"
		},
		{
			id: "neck-right",
			name: "Right Neck",
			view: ViewSide.FRONT,
			path: "m 13.304665,11.910505 1.64975,2.35202 0.74426,2.62159 -1.73486,-1.38354 -0.86649,-2.97104 z"
		},
		{
			id: "neck-left",
			name: "Left Neck",
			view: ViewSide.FRONT,
			path: "m 18.385135,11.910505 -1.64975,2.35202 -0.74538,2.62234 1.73486,-1.38354 0.86649,-2.97104 z"
		},
		{
			id: "shoulder-front-left",
			name: "Left Shoulder (Front)",
			view: ViewSide.FRONT,
			path: "m 19.047795,13.248365 3.55748,1.97916 0.72653,-0.35074 z m -0.107,0.43288 -0.37119,1.73073 2.1846,0.53561 1.40116,-0.49436 z"
		},
		{
			id: "shoulder-side-left",
			name: "Left Shoulder (Side)",
			view: ViewSide.FRONT,
			path: "m 22.922305,15.657195 0.75814,-0.41 2.40806,1.66799 1.17364,1.50707 0.62662,1.5626 -0.0464,3.70194 -1.3284,-1.72153 0.0407,-2.59376 -0.48842,-0.50049 c 0,0 -3.09778,-3.19058 -3.14371,-3.21401 z m -0.2409,0.10873 c -0.001,0.0525 3.32987,3.54733 3.32987,3.54733 l 0.10067,3.10396 -1.15426,-1.97782 -2.22547,-0.94804 -1.56576,-2.88481 z"
		},
		{
			id: "shoulder-front-right",
			name: "Right Shoulder (Front)",
			view: ViewSide.FRONT,
			path: "m 12.624785,13.248365 -3.5574599,1.97916 -0.72653,-0.35074 z m 0.107,0.43288 0.37119,1.73073 -2.18459,0.53561 -1.4011499,-0.49436 z"
		},
		{
			id: "shoulder-side-right",
			name: "Right Shoulder (Side)",
			view: ViewSide.FRONT,
			path: "m 8.7502951,15.657195 -0.75814,-0.41 -2.40806,1.66799 -1.17364,1.50707 -0.62662,1.56259 0.0464,3.70195 1.3284,-1.72153 -0.0407,-2.59376 0.48843,-0.5005 c 0,0 3.09777,-3.19057 3.1437,-3.214 z m 0.2409,0.10873 c 0.002,0.0525 -3.32987,3.54733 -3.32987,3.54733 l -0.10067,3.10396 1.15426,-1.97782 2.22547,-0.94804 1.5657499,-2.88481 z"
		},
		{
			id: "biceps-left",
			name: "Left Biceps",
			view: ViewSide.FRONT,
			path: "m 27.621665,30.814715 -0.33838,1.70499 -1.81932,-2.54418 -0.6629,-1.26895 z m -2.85271,-2.6096 c -0.0259,-0.0144 -0.0536,-0.0254 -0.0824,-0.0324 l -1.48333,-4.95503 1.00456,-2.08428 1.65511,1.74532 2.23034,6.67667 0.0415,0.93739 c -1.06528,-0.84215 -2.18962,-1.60679 -3.36434,-2.28803 z m 1.6945,-5.75654 1.64893,6.43421 -0.36469,-4.92266 z"
		},
		{
			id: "forearm-left",
			name: "Left Forearm",
			view: ViewSide.FRONT,
			path: "m 26.955425,32.969125 1.30083,10.28927 -1.10778,0.01 -1.89387,-7.99609 0.19174,-4.53719 z m 1.21978,-1.94971 -0.58729,2.58635 1.11876,9.15614 0.55849,-0.21663 0.2304,-6.77018 z"
		},
		{
			id: "biceps-right",
			name: "Right Biceps",
			view: ViewSide.FRONT,
			path: "m 4.0746451,30.814715 0.33838,1.70499 1.81931,-2.54418 0.66289,-1.26895 z m 2.8527,-2.6096 c 0.0259,-0.0144 0.0536,-0.0254 0.0824,-0.0324 l 1.48332,-4.95503 -1.00455,-2.08428 -1.65509,1.74532 -2.23034,6.67667 -0.0415,0.93739 c 1.06528,-0.84215 2.18961,-1.60679 3.36433,-2.28803 z m -1.6945,-5.75654 -1.64891,6.43421 0.36468,-4.92266 z"
		},
		{
			id: "forearm-right",
			name: "Right Forearm",
			view: ViewSide.FRONT,
			path: "m 4.5752651,32.969125 -1.30083,10.28927 1.10778,0.01 1.89387,-7.99609 -0.19174,-4.53719 z m -1.21978,-1.94971 0.58728,2.58635 -1.11875,9.15614 -0.55849,-0.21663 -0.2304,-6.77018 z"
		},
		{
			id: "chest-upper-left",
			name: "Left Upper Chest (Clavicular)",
			view: ViewSide.FRONT,
			path: "m 20.337455,17.085495 1.72942,3.09103 1.890,0.94 -0.5,0.3 -6.8, -2.1 z"
		},
		{
			id: "chest-lower-left",
			name: "Left Lower Chest (Sternal)",
			view: ViewSide.FRONT,
			path: "m 16.66,19.72 6.8,2.1 -0.65,0.5 -0.90604,2.63773 -2.09968,0.86537 -3.34524,-1.655 0.2,-3.8 z"
		},
		{
			id: "chest-upper-right",
			name: "Right Upper Chest (Clavicular)",
			view: ViewSide.FRONT,
			path: "m 11.351215,17.085495 -1.7294199,3.09103 -1.890,0.94 0.5,0.3 6.8,-2.1 z"
		},
		{
			id: "chest-lower-right",
			name: "Right Lower Chest (Sternal)",
			view: ViewSide.FRONT,
			path: "m 15.03,19.72 -6.8,2.1 0.65,0.5 0.90586,2.63773 2.0996699,0.86537 3.34636,-1.655 -0.2,-3.8 z"
		},
		{
			id: "abs-upper-left",
			name: "Left Abs (Upper)",
			view: ViewSide.FRONT,
			path: "m 19.641935,34.707615 1.81341,-1.36479 0.15748,1.83347 1.28642,2.37338 -1.98044,2.73652 -1.03109,0.16554 -0.37026,-3.88816 z"
		},
		{
			id: "serratus-anterior-left",
			name: "Left Serratus Anterior",
			view: ViewSide.FRONT,
			path: "M 19.289,26.152 l -3.11202 -1.40604 0.0937 2.27965 2.80119 1.43603 z M 21.224,27.820 l -1.29355 0.7212 0.14997 -1.70898 z M 20.171,26.183 l 2.47968 -1.03241 -0.9336 2.52093 z M 21.702,27.921 l -1.69005 1.03372 -0.28871 2.0678 1.64975 -1.07533 z"
		},
		{
			id: "obliques-left",
			name: "Left External Oblique",
			view: ViewSide.FRONT,
			path: "M 18.791,29.025 l -0.0622 1.62387 -2.30308 -0.49961 -0.12448 -2.21722 z M 18.635,31.429 l 0.0311 1.99844 -2.20953 0.59391 -0.0311 -3.1227 z M 21.290,30.444 l -1.48383 1.03372 -0.20622 2.10905 1.64862 -1.32355 z"
		},
		{
			id: "abs-upper-right",
			name: "Right Abs (Upper)",
			view: ViewSide.FRONT,
			path: "m 12.045985,34.707615 -1.81341,-1.36479 -0.15748,1.83347 -1.2856799,2.37432 1.9804499,2.73595 1.03109,0.16554 0.37119,-3.88721 z"
		},
		{
			id: "abs-lower-right",
			name: "Right Lower Abs",
			view: ViewSide.FRONT,
			path: "m 15.636055,44.919735 -0.60647,-5.91209 -0.015,-3.84879 -2.18479,-1.07533 -0.24746,7.03017 z"
		},
		{
			id: "abs-lower-left",
			name: "Left Lower Abs",
			view: ViewSide.FRONT,
			path: "m 16.051865,44.919165 0.60628,-5.91209 0.0154,-3.84915 2.18404,-1.07515 0.24746,7.03017 z"
		},
		{
			id: "serratus-anterior-right",
			name: "Right Serratus Anterior",
			view: ViewSide.FRONT,
			path: "m 12.399365,26.152365 3.11202,-1.40603 -0.0937,2.27965 -2.80138,1.4364 z m -1.93508,1.6685 1.29355,0.72139 -0.14997,-1.70899 z m 1.05303,-1.637 -2.4793099,-1.03259 0.93361,2.52148 z m -1.5316399,1.73729 1.6900499,1.03372 0.28871,2.06743 -1.64881,-1.07515 z"
		},
		{
			id: "obliques-right",
			name: "Right External Oblique",
			view: ViewSide.FRONT,
			path: "M 12.897,29.025 l 0.0623 1.62387 2.30327 -0.49961 0.12448 -2.21703 z M 13.053,31.430 l -0.0309 1.99844 2.20973 0.59353 0.0311 -3.1227 z M 10.398,30.445 l 1.48384 1.0339 0.20622 2.10905 -1.64975 -1.32355 z"
		},
		{
			id: "hip-flexor-right",
			name: "Right Groin / Hip Flexors",
			view: ViewSide.FRONT,
			path: "m 14.404465,45.040075 0.0221,-0.0277 -0.14866,-0.37945 -3.10172,-3.40449 -0.23283,-0.0825 2.05918,5.32009 z m -1.17263,2.01833 1.27705,3.29948 0.42631,-4.04862 -0.25196,-0.64303 z"
		},
		{
			id: "hip-flexor-left",
			name: "Left Groin / Hip Flexors",
			view: ViewSide.FRONT,
			path: "m 17.284025,45.040455 -0.0221,-0.0281 0.14867,-0.37926 3.10171,-3.40449 0.23246,-0.0825 -2.05843,5.3199 z m 1.17263,2.01795 -1.27706,3.29948 -0.42631,-4.04843 0.25197,-0.64303 z"
		},
		{
			id: "quads-left",
			name: "Left Quadriceps",
			view: ViewSide.FRONT,
			path: "m 23.419015,50.399125 -0.15504,4.75091 -2.40263,6.60949 0.7362,1.90021 2.36401,-8.34435 z m -0.58154,-11.60825 -0.15485,4.00722 1.31793,7.93154 0.61977,-6.40308 z m -0.38731,5.12268 -2.75152,6.07258 -0.62015,4.87425 1.16232,6.85771 2.51886,-6.98144 0.15504,-7.18764 z"
		},
		{
			id: "adductors-left",
			name: "Left Adductors",
			view: ViewSide.FRONT,
			path: "m 22.063225,39.369605 v 4.21363 l -2.94574,5.82511 -1.86027,5.78349 0.19365,-4.0072 z m -3.24944,13.42596 -0.0649,0.15467 -1.21294,2.90207 0.78325,7.18803 1.23619,-0.66122 -1.0714,-6.69272 z"
		},
		{
			id: "foot-left",
			name: "Left Foot",
			view: ViewSide.FRONT,
			path: "m 17.255895,87.868445 0.1243,3.45228 0.28983,1.20638 h 0.87136 l 0.24897,-0.83181 0.29058,-0.0416 -0.0624,0.83181 1.09914,-0.33332 0.29058,-0.16629 1.24444,-0.27033 0.0416,-0.97748 -1.20319,-2.03743 -0.82974,-1.0399 -2.03294,-0.83181 z"
		},
		{
			id: "tibialis-anterior-left",
			name: "Left Tibialis Anterior",
			view: ViewSide.FRONT,
			path: "m 18.251375,70.441125 0.29058,0.91486 0.6224,3.8681 0.0829,5.15733 -0.87136,5.03304 0.0412,-6.44714 -0.91242,-2.57848 -0.12561,-2.82837 z m 1.9915,2.32915 -0.20753,7.73637 -1.65949,6.23904 1.80478,-0.853 3.00816,-10.83583 -1.03727,-6.82095 z"
		},
		{
			id: "knee-left",
			name: "Left Knee",
			view: ViewSide.FRONT,
			path: "m 21.404635,64.784375 0.1243,1.12295 -0.87118,1.08171 -0.29058,1.70599 -0.58116,0.24933 -0.49774,-2.57866 -0.33182,-0.91486 0.29058,-0.58247 z m -3.85853,0.0832 0.6224,1.74685 1.3273,2.57867 -0.33182,2.37095 -0.95423,-2.66209 -0.78738,-1.49734 z m 4.97811,-2.37039 -0.95423,5.11609 0.62241,-0.33295 0.49773,1.66381 z"
		},
		{
			id: "quads-right",
			name: "Right Quadriceps",
			view: ViewSide.FRONT,
			path: "m 8.2694651,50.399125 0.15504,4.75053 2.4026299,6.60968 -0.73638,1.90021 -2.3640099,-8.34435 z m 0.58117,-11.60768 0.15503,4.00684 -1.31754,7.93154 -0.61978,-6.40308 z m 0.38769,5.1223 2.7515099,6.07239 0.61997,4.87425 -1.16232,6.85771 -2.5190499,-6.98163 -0.15504,-7.18801 z"
		},
		{
			id: "adductors-right",
			name: "Right Adductors",
			view: ViewSide.FRONT,
			path: "m 9.6258251,39.369415 v 4.21363 l 2.9451699,5.8253 1.86028,5.78349 -0.19366,-4.0072 z m 3.2488699,13.42559 0.0647,0.15485 1.21294,2.90207 -0.78307,7.18803 -1.23618,-0.66102 1.0714,-6.69273 z"
		},
		{
			id: "foot-right",
			name: "Right Foot",
			view: ViewSide.FRONT,
			path: "m 14.433335,87.868265 -0.12448,3.45228 -0.29058,1.20637 h -0.87118 l -0.24877,-0.83181 -0.29059,-0.0416 0.0623,0.83181 -1.09934,-0.33333 -0.29058,-0.16629 -1.2448,-0.27033 -0.0412,-0.97747 1.2031899,-2.03781 0.82975,-1.04009 2.03294,-0.83181 z"
		},
		{
			id: "tibialis-anterior-right",
			name: "Right Tibialis Anterior",
			view: ViewSide.FRONT,
			path: "m 13.437675,70.440945 -0.29058,0.91486 -0.62241,3.86828 -0.0829,5.15733 0.87174,5.03304 -0.0418,-6.44714 0.91298,-2.57848 0.1243,-2.82837 z m -1.99151,2.32914 0.20735,7.73637 1.65968,6.23904 -1.80497,-0.85299 -3.0079799,-10.83584 1.03728,-6.82095 z"
		},
		{
			id: "knee-right",
			name: "Right Knee",
			view: ViewSide.FRONT,
			path: "m 10.284405,64.784375 -0.12448,1.12295 0.87118,1.08171 0.29058,1.70599 0.58116,0.24933 0.49774,-2.57866 0.33182,-0.91486 -0.29058,-0.58247 z m 3.85854,0.0832 -0.62241,1.74685 -1.32767,2.57867 0.33182,2.37095 0.95423,-2.66209 0.78832,-1.4964 z m -4.9786799,-2.37058 0.9542299,5.11609 -0.6223999,-0.33313 -0.49793,1.6638 z"
		},
		{
			id: "elbow-right",
			name: "Right Elbow",
			view: ViewSide.FRONT,
			path: "m 3.2054751,27.370125 0.005,3.09419 -0.57959,1.91184 -0.54539,-2.41185 z"
		},
		{
			id: "hand-right",
			name: "Right Hand",
			view: ViewSide.FRONT,
			path: "m 4.3904451,43.563145 -1.5198,0.0506 -0.76631,-0.67112 -1.21261996,2.15767 -0.86245,3.32873 0.49386,0.22113 0.59814996,-2.20238 0.50016,0.25356 -0.35639,2.49422 0.62382,0.24345 0.41402,-2.49194 0.55839,0.17851 -0.2262,2.76603 0.76938,0.32268 0.25788,-2.86764 0.4578,-0.0181 0.16611,2.65239 0.65997,0.2633 0.0712,-4.56643 0.34158,-0.19428 1.35316,1.68367 0.32832,-0.34354 -0.72644,-2.0551 z"
		},
		{
			id: "elbow-left",
			name: "Left Elbow",
			view: ViewSide.FRONT,
			path: "m 28.325215,27.370125 -0.005,3.09419 0.57959,1.91184 0.54538,-2.41185 z"
		},
		{
			id: "hand-left",
			name: "Left Hand",
			view: ViewSide.FRONT,
			path: "m 27.140245,43.563145 1.5198,0.0506 0.76631,-0.67111 1.21262,2.15766 0.86245,3.32873 -0.49386,0.22113 -0.59815,-2.20238 -0.50016,0.25356 0.35639,2.49422 -0.62382,0.24345 -0.41402,-2.49194 -0.55839,0.17851 0.2262,2.76603 -0.76938,0.32268 -0.25788,-2.86764 -0.4578,-0.0181 -0.16611,2.6524 -0.65997,0.26329 -0.0712,-4.56643 -0.34158,-0.19428 -1.35316,1.68368 -0.32832,-0.34355 0.72644,-2.0551 z"
		}
	];
	//#endregion
	//#region node_modules/body-muscles/dist/esm/data/muscles.back.js
	/**
	* Back (Posterior) view muscle definitions
	* All muscle paths with x > 35 in the SVG coordinate system
	*/
	var BACK_MUSCLES = [
		{
			id: "head-back",
			name: "Head (Posterior)",
			view: ViewSide.BACK,
			path: "m 48.157455,6.3585449 0.44208,-0.14964 0.16111,0.16427 1.48163,4.0475101 2.32401,1.45118 2.39971,-1.52387 0.97577,-3.6896901 0.52752,-0.55908 0.23367,0.0981 0.24198,-3.34467 -2.03129,-2.31103004 -2.84509,-0.51629 -2.20422,0.52915 -1.93631,2.63077004 z"
		},
		{
			id: "nape",
			name: "Nape",
			view: ViewSide.BACK,
			path: "m 52.369695,12.105075 -2.35767,-1.55045 -1.47119,-3.9514301 -0.60741,0.0403 0.27409,1.82447 0.97635,0.33932 0.7613,2.2157201 0.33017,1.06849 0.0895,2.14894 1.16448,0.008 0.10563,-0.70833 0.54716,-0.0606 z m 1.01793,1.47595 0.23768,0.64982 1.38107,-0.004 0.01,-2.38784 0.25971,-0.79061 0.57215,-2.1698001 0.76359,-0.41018 0.25158,-1.78416 -0.62859,0.0193 -1.08488,3.8998101 -2.39725,1.46684 0.2768,1.48507 z"
		},
		{
			id: "traps-upper-left",
			name: "Left Trapezius (Upper)",
			view: ViewSide.BACK,
			path: "M 49.625,14.629 L 49.688,12.005 L 48.974,13.157 L 44.594,14.654 L 45.945,16.925 L 51.222,16.925 L 51.183,14.550 Z"
		},
		{
			id: "traps-mid-left",
			name: "Left Trapezius (Mid)",
			view: ViewSide.BACK,
			path: "M 46.034,17.075 L 48.920,21.925 L 51.303,21.925 L 51.224,17.075 Z"
		},
		{
			id: "traps-lower-left",
			name: "Left Trapezius (Lower)",
			view: ViewSide.BACK,
			path: "M 49.009,22.075 L 49.572,23.022 L 51.403,28.104 L 51.305,22.075 Z"
		},
		{
			id: "traps-upper-right",
			name: "Right Trapezius (Upper)",
			view: ViewSide.BACK,
			path: "M 55.439,14.729 L 55.376,12.104 L 56.090,13.256 L 60.470,14.754 L 59.179,16.925 L 53.844,16.925 L 53.881,14.649 Z"
		},
		{
			id: "traps-mid-right",
			name: "Right Trapezius (Mid)",
			view: ViewSide.BACK,
			path: "M 59.089,17.075 L 56.204,21.925 L 53.763,21.925 L 53.842,17.075 Z"
		},
		{
			id: "traps-lower-right",
			name: "Right Trapezius (Lower)",
			view: ViewSide.BACK,
			path: "M 56.114,22.075 L 55.492,23.121 L 53.661,28.203 L 53.761,22.075 Z"
		},
		{
			id: "lats-upper-left",
			name: "Left Lats (Upper)",
			view: ViewSide.BACK,
			path: "M 44.144,15.285 L 39.888,20.286 L 39.426,22.749 L 41.263,21.510 L 44.025,20.355 L 45.663,23.400 L 49.103,23.400 Z"
		},
		{
			id: "deltoid-rear-left",
			name: "Left Rear Deltoid",
			view: ViewSide.BACK,
			path: "M 42.201,16.586 L 40.626,18.152 L 39.736,20.156 L 43.992,15.155 Z"
		},
		{
			id: "lats-mid-left",
			name: "Left Lats (Mid)",
			view: ViewSide.BACK,
			path: "M 45.771,23.600 L 45.872,23.789 L 47.009,29.286 L 47.023,30.400 L 51.080,30.400 L 51.053,28.314 L 49.185,23.600 Z"
		},
		{
			id: "lats-lower-left",
			name: "Left Lats (Lower)",
			view: ViewSide.BACK,
			path: "M 47.026,30.600 L 47.086,35.145 L 51.156,36.255 L 51.082,30.600 Z"
		},
		{
			id: "deltoid-rear-right",
			name: "Right Rear Deltoid",
			view: ViewSide.BACK,
			path: "M 62.863,16.686 L 64.438,18.251 L 65.328,20.255 L 61.073,15.254 Z"
		},
		{
			id: "lats-upper-right",
			name: "Right Lats (Upper)",
			view: ViewSide.BACK,
			path: "M 60.921,15.384 L 65.176,20.385 L 65.290,22.849 L 63.801,21.609 L 61.039,20.454 L 59.455,23.400 L 56.022,23.400 Z"
		},
		{
			id: "lats-mid-right",
			name: "Right Lats (Mid)",
			view: ViewSide.BACK,
			path: "M 59.347,23.600 L 59.192,23.888 L 58.055,29.385 L 58.042,30.400 L 53.986,30.400 L 54.012,28.413 L 55.918,23.600 Z"
		},
		{
			id: "lats-lower-right",
			name: "Right Lats (Lower)",
			view: ViewSide.BACK,
			path: "M 58.039,30.600 L 57.979,35.245 L 53.908,36.354 L 53.983,30.600 Z"
		},
		{
			id: "triceps-long-left",
			name: "Left Triceps (Long Head)",
			view: ViewSide.BACK,
			path: "M 43.593,21.039 L 44.920,23.967 L 43.615,25.653 L 43.186,27.069 L 39.209,29.802 Z"
		},
		{
			id: "triceps-lateral-left",
			name: "Left Triceps (Lateral Head)",
			view: ViewSide.BACK,
			path: "M 43.459,20.972 L 39.075,29.735 L 38.871,25.461 L 39.407,23.674 L 41.242,21.927 Z"
		},
		{
			id: "hand-back-left",
			name: "Left Hand (Back)",
			view: ViewSide.BACK,
			path: "M 40.716955,42.424835 l -1.5182,0.0863 -0.78184,-0.65295 -1.16168,2.1855 -0.78414,3.34805 0.49892,0.20949 0.54632,-2.2158 0.50597,0.24175 -0.29779,2.5019 0.62936,0.22875 0.35546,-2.50096 0.56242,0.16536 -0.16126,2.77057 0.77674,0.30455 0.19056,-2.87291 0.45724,-0.0289 0.22827,2.64778 0.66597,0.24774 -0.0359,-4.56685 0.33693,-0.20224 1.39227,1.65147 0.32017,-0.35115 -0.77444,-2.03749 z"
		},
		{
			id: "forearm-flexors-left",
			name: "Forearm Flexors Left",
			view: ViewSide.BACK,
			path: "M 40.775,29.006 L 42.870,27.644 L 42.187,29.635 L 42.603,34.383 L 40.799,42.081 L 39.814,42.253 Z"
		},
		{
			id: "forearm-extensors-left",
			name: "Forearm Extensors Left",
			view: ViewSide.BACK,
			path: "M 39.665,42.242 L 38.305,41.501 L 37.998,34.491 L 38.635,31.429 L 39.245,30.209 L 40.625,28.994 Z"
		},
		{
			id: "triceps-long-right",
			name: "Right Triceps (Long Head)",
			view: ViewSide.BACK,
			path: "M 61.376,21.213 L 60.056,24.145 L 61.330,26.199 L 61.657,27.251 L 65.780,29.966 Z"
		},
		{
			id: "triceps-lateral-right",
			name: "Right Triceps (Lateral Head)",
			view: ViewSide.BACK,
			path: "M 61.510,21.146 L 65.914,29.899 L 66.108,25.624 L 65.568,23.839 L 63.729,22.096 Z"
		},
		{
			id: "hand-back-right",
			name: "Right Hand (Back)",
			view: ViewSide.BACK,
			path: "M 64.301385,42.592325 l 1.51839,0.0828 0.78033,-0.65476 1.16673,2.18281 0.79187,3.34623 -0.49843,0.21064 -0.55144,-2.21453 -0.50541,0.24292 0.30356,2.5012 -0.62882,0.23021 -0.36124,-2.50014 -0.56203,0.16666 0.16765,2.77019 -0.77603,0.30634 -0.19719,-2.87245 -0.45732,-0.0278 -0.22215,2.64829 -0.66539,0.24928 0.0254,-4.56692 -0.3374,-0.20146 -1.38845,1.65469 -0.32098,-0.35041 0.76973,-2.03928 z"
		},
		{
			id: "forearm-flexors-right",
			name: "Forearm Flexors Right",
			view: ViewSide.BACK,
			path: "M 65.204,42.420 L 63.925,29.007 L 61.764,27.798 L 62.786,29.733 L 62.397,34.555 L 64.219,42.248 Z"
		},
		{
			id: "forearm-extensors-right",
			name: "Forearm Extensors Right",
			view: ViewSide.BACK,
			path: "M 64.075,28.993 L 65.353,42.405 L 66.712,41.663 L 67.002,34.653 L 66.358,31.591 L 65.745,30.373 Z"
		},
		{
			id: "spine",
			name: "Spine",
			view: ViewSide.BACK,
			path: "m 51.733705,14.788555 0.53876,25.33066 0.48967,-0.0297 0.65658,-25.3387 -0.28147,-0.84188 -1.25059,-4.9e-4 z"
		},
		{
			id: "lower-back-erectors-left",
			name: "Erector Spinae Left",
			view: ViewSide.BACK,
			path: "M 52.100,37.310 L 49.537,36.465 L 50.244,40.788 L 52.200,42.030 L 52.200,40.270 L 52.150,40.280 Z"
		},
		{
			id: "lower-back-ql-left",
			name: "Quadratus Lumborum Left",
			view: ViewSide.BACK,
			path: "M 49.389,36.490 L 46.240,35.460 L 44.720,39.420 L 50.096,40.812 Z"
		},
		{
			id: "lower-back-erectors-right",
			name: "Erector Spinae Right",
			view: ViewSide.BACK,
			path: "M 52.800,42.030 L 52.800,40.270 L 52.850,40.260 L 52.900,37.290 L 55.289,36.625 L 54.805,40.801 Z"
		},
		{
			id: "lower-back-ql-right",
			name: "Quadratus Lumborum Right",
			view: ViewSide.BACK,
			path: "M 55.439,36.643 L 55.980,36.470 L 58.320,35.720 L 59.660,39.450 L 54.955,40.819 Z"
		},
		{
			id: "gluteus-medius-left",
			name: "Gluteus Medius Left",
			view: ViewSide.BACK,
			path: "M 50.191,41.481 L 44.740,39.690 L 43.830,41.580 L 43.431,44.301 Z"
		},
		{
			id: "gluteus-maximus-left",
			name: "Gluteus Maximus Left",
			view: ViewSide.BACK,
			path: "M 50.249,41.619 L 43.489,44.439 L 44.410,50.520 L 47.180,51.030 L 51.620,49.090 L 52.200,49.480 L 52.200,42.880 Z"
		},
		{
			id: "gluteus-medius-right",
			name: "Gluteus Medius Right",
			view: ViewSide.BACK,
			path: "M 55.274,41.079 L 61.354,45.519 L 60.640,42.150 L 59.740,39.860 Z"
		},
		{
			id: "gluteus-maximus-right",
			name: "Gluteus Maximus Right",
			view: ViewSide.BACK,
			path: "M 55.186,41.201 L 52.800,42.880 L 52.800,49.480 L 53.570,49.090 L 57.680,50.760 L 60.500,50.600 L 61.266,45.641 Z"
		},
		{
			id: "knee-back-left",
			name: "Left Back Knee",
			view: ViewSide.BACK,
			path: "m 51.176145,64.073985 -1.20605,3.01461 0.70738,0.26558 0.89754,3.51771 -0.55801,-4.01191 z m -5.08496,-3.15003 0.63355,1.8609 0.16813,2.03261 0.61314,1.93117 -0.90585,-0.0851 -0.28534,2.15982 z"
		},
		{
			id: "knee-back-right",
			name: "Right Back Knee",
			view: ViewSide.BACK,
			path: "m 54.019305,64.073985 1.20605,3.01461 -0.70737,0.26558 -0.89755,3.51771 0.55802,-4.01191 z m 5.08496,-3.15003 -0.63355,1.8609 -0.16813,2.03261 -0.61313,1.93117 0.90584,-0.0851 0.28534,2.15982 z"
		},
		{
			id: "calves-gastroc-medial-left",
			name: "Gastrocnemius Medial Left",
			view: ViewSide.BACK,
			path: "M 50.568,67.512 L 51.669,72.509 L 51.379,75.532 L 51.292,76.825 L 48.983,76.825 Z"
		},
		{
			id: "calves-gastroc-lateral-left",
			name: "Gastrocnemius Lateral Left",
			view: ViewSide.BACK,
			path: "M 50.218,67.512 L 48.633,76.825 L 46.283,76.825 L 45.533,74.263 L 46.783,67.088 Z"
		},
		{
			id: "calves-soleus-left",
			name: "Soleus Left",
			view: ViewSide.BACK,
			path: "M 46.386,77.175 L 51.269,77.175 L 50.701,85.598 L 49.037,86.233 Z"
		},
		{
			id: "calves-gastroc-medial-right",
			name: "Gastrocnemius Medial Right",
			view: ViewSide.BACK,
			path: "M 54.628,67.512 L 53.526,72.509 L 53.816,75.532 L 53.903,76.825 L 56.213,76.825 Z"
		},
		{
			id: "calves-gastroc-lateral-right",
			name: "Gastrocnemius Lateral Right",
			view: ViewSide.BACK,
			path: "M 54.978,67.512 L 56.563,76.825 L 58.912,76.825 L 59.662,74.263 L 58.412,67.088 Z"
		},
		{
			id: "calves-soleus-right",
			name: "Soleus Right",
			view: ViewSide.BACK,
			path: "M 53.927,77.175 L 58.810,77.175 L 56.158,86.233 L 54.495,85.598 Z"
		},
		{
			id: "foot-back-left",
			name: "Left Foot (Back)",
			view: ViewSide.BACK,
			path: "M 50.933115,88.340995 l 0.85194,1.3581 0.37189,0.79238 -0.15588,1.21774 -0.76984,0.74446 -1.51185,0.12543 -1.1299,-0.29192 -0.24225,-0.95894 0.80765,-1.30405 -0.22562,-0.85987 0.29679,-0.84153 -0.0194,-1.81524 1.53568,-0.54817 z m -1.19598,0.4675 0.15943,1.25776 -0.6023,0.97431 m -0.54436,0.29544 1.06474,0.40084 1.55326,-0.65137 z"
		},
		{
			id: "hamstrings-medial-left",
			name: "Medial Hamstrings (Semis) Left",
			view: ViewSide.BACK,
			path: "M 49.550,50.504 L 51.751,49.461 L 52.389,49.692 L 52.424,51.499 L 52.499,56.145 L 50.521,62.188 L 50.997,63.602 L 49.569,66.897 L 48.755,66.754 Z"
		},
		{
			id: "hamstrings-lateral-left",
			name: "Lateral Hamstrings (Biceps) Left",
			view: ViewSide.BACK,
			path: "M 49.400,50.496 L 48.605,66.746 L 47.803,66.596 L 47.302,64.480 L 47.133,62.723 L 44.712,54.565 L 44.369,50.918 L 47.200,51.500 Z"
		},
		{
			id: "foot-back-right",
			name: "Right Foot (Back)",
			view: ViewSide.BACK,
			path: "M 54.262335,88.340995 l -0.85194,1.3581 -0.37189,0.79238 0.15589,1.21774 0.76983,0.74446 1.51186,0.12543 1.12989,-0.29192 0.24225,-0.95894 -0.80765,-1.30405 0.22563,-0.85987 -0.29679,-0.84153 0.0194,-1.81524 -1.53568,-0.54817 z m 1.19598,0.4675 -0.15943,1.25776 0.6023,0.97431 m 0.54436,0.29544 -1.06474,0.40084 -1.55326,-0.65137 z"
		},
		{
			id: "hamstrings-medial-right",
			name: "Medial Hamstrings (Semis) Right",
			view: ViewSide.BACK,
			path: "M 57.425,51.196 L 56.565,66.806 L 55.759,66.965 L 54.331,63.670 L 54.807,62.256 L 52.829,56.213 L 52.904,51.567 L 52.956,49.769 L 53.520,49.498 Z"
		},
		{
			id: "hamstrings-lateral-right",
			name: "Lateral Hamstrings (Biceps) Right",
			view: ViewSide.BACK,
			path: "M 57.575,51.204 L 60.625,50.950 L 60.616,54.633 L 58.195,62.791 L 58.026,64.547 L 57.525,66.663 L 56.715,66.814 Z"
		}
	];
	[...FRONT_MUSCLES, ...BACK_MUSCLES];
	/**
	* Intensity color gradient mapping (0-10 scale)
	* Colors progress from yellow (low) → orange (mid) → red (high)
	*/
	var INTENSITY_COLORS = {
		0: "#94a3b8",
		1: "#fde047",
		2: "#facc15",
		3: "#eab308",
		4: "#fb923c",
		5: "#f97316",
		6: "#ea580c",
		7: "#ef4444",
		8: "#dc2626",
		9: "#b91c1c",
		10: "#7f1d1d"
	};
	//#endregion
	//#region node_modules/body-muscles/dist/esm/utils/getMuscleColor.js
	/**
	* Get the fill color for a muscle based on its state and hover
	*/
	function getMuscleColor(state, isHovered) {
		if (state.intensity > 0) return INTENSITY_COLORS[Math.min(Math.round(state.intensity), 10)] || INTENSITY_COLORS[10];
		return INTENSITY_COLORS[0];
	}
	//#endregion
	//#region node_modules/body-muscles/dist/esm/utils/filterMuscles.js
	/**
	* Get muscle definitions filtered by anatomical view
	*/
	function filterMuscles(view) {
		return view === ViewSide.FRONT ? FRONT_MUSCLES : BACK_MUSCLES;
	}
	//#endregion
	//#region node_modules/body-muscles/dist/esm/BodyChart.js
	var SVG_NS = "http://www.w3.org/2000/svg";
	function resolveOptions(options) {
		return {
			className: "",
			ariaLabel: "",
			showViewLabel: false,
			enableTransitions: true,
			onMuscleClick: () => {},
			onMuscleHover: () => {},
			...options
		};
	}
	/**
	* BodyChart — Framework-agnostic interactive SVG body map
	*
	* Renders a detailed human body with 70+ clickable muscle regions into any DOM element.
	* Supports dual views (anterior/posterior), intensity visualization (0-10 scale),
	* and interactive selection states with visual feedback.
	*
	* @example
	* ```ts
	* const chart = new BodyChart(document.getElementById('container')!, {
	*   view: ViewSide.FRONT,
	*   bodyState: { 'biceps-left': { intensity: 7, selected: true } },
	*   onMuscleClick: (id, name) => console.log(`Clicked: ${name}`),
	* });
	*
	* // Update state
	* chart.update({ bodyState: newState });
	*
	* // Switch view
	* chart.update({ view: ViewSide.BACK });
	*
	* // Cleanup
	* chart.destroy();
	* ```
	*/
	var BodyChart = class {
		constructor(container, options) {
			this.hoveredMuscle = null;
			this.wrapperEl = null;
			this.svgEl = null;
			this.labelEl = null;
			this.musclePaths = /* @__PURE__ */ new Map();
			this.muscleData = [];
			this.eventCleanup = [];
			this.container = container;
			this.options = resolveOptions(options);
			this.build();
		}
		/**
		* Update chart options. Partial updates are merged with current options.
		* Changing `view` triggers a full re-render; other changes update in-place.
		*/
		update(options) {
			const viewChanged = options.view !== void 0 && options.view !== this.options.view;
			Object.assign(this.options, options);
			if (viewChanged) {
				this.destroy();
				this.build();
			} else this.refreshAllPaths();
		}
		/**
		* Remove the chart from the DOM and clean up all event listeners.
		*/
		destroy() {
			for (const fn of this.eventCleanup) fn();
			this.eventCleanup = [];
			this.musclePaths.clear();
			this.muscleData = [];
			if (this.wrapperEl && this.container.contains(this.wrapperEl)) this.container.removeChild(this.wrapperEl);
			this.wrapperEl = null;
			this.svgEl = null;
			this.labelEl = null;
		}
		build() {
			const { view, className, ariaLabel, showViewLabel, enableTransitions } = this.options;
			this.muscleData = filterMuscles(view);
			const viewBox = view === ViewSide.FRONT ? "0 0 35 93" : "37 0 35 93";
			this.wrapperEl = document.createElement("div");
			this.wrapperEl.className = `body-chart-container ${className}`.trim();
			setStyles(this.wrapperEl, {
				position: "relative",
				width: "100%",
				height: "100%",
				display: "flex",
				justifyContent: "center",
				alignItems: "center",
				padding: "1rem"
			});
			this.wrapperEl.setAttribute("role", "img");
			this.wrapperEl.setAttribute("aria-label", ariaLabel || `${view === ViewSide.FRONT ? "Anterior" : "Posterior"} body map view`);
			this.svgEl = document.createElementNS(SVG_NS, "svg");
			this.svgEl.setAttribute("viewBox", viewBox);
			this.svgEl.classList.add("body-chart-svg");
			this.svgEl.setAttribute("aria-hidden", "true");
			setStyles(this.svgEl, {
				height: "auto",
				width: "100%",
				maxHeight: "70vh",
				maxWidth: "400px",
				filter: "drop-shadow(0 4px 20px rgba(0, 0, 0, 0.3))",
				...enableTransitions ? { transition: "all 200ms ease-out" } : {}
			});
			this.svgEl.appendChild(this.buildDefs());
			const bgGroup = document.createElementNS(SVG_NS, "g");
			bgGroup.classList.add("body-chart-background");
			bgGroup.setAttribute("aria-hidden", "true");
			bgGroup.style.opacity = "0.1";
			bgGroup.style.pointerEvents = "none";
			for (const m of this.muscleData) {
				const p = document.createElementNS(SVG_NS, "path");
				p.setAttribute("d", m.path);
				p.setAttribute("fill", "#cbd5e1");
				bgGroup.appendChild(p);
			}
			this.svgEl.appendChild(bgGroup);
			for (const muscle of this.muscleData) {
				const path = this.buildMusclePath(muscle);
				this.svgEl.appendChild(path);
				this.musclePaths.set(muscle.id, path);
			}
			this.wrapperEl.appendChild(this.svgEl);
			if (showViewLabel) {
				this.labelEl = this.buildViewLabel(view);
				this.wrapperEl.appendChild(this.labelEl);
			}
			this.container.appendChild(this.wrapperEl);
			this.refreshAllPaths();
		}
		buildDefs() {
			const defs = document.createElementNS(SVG_NS, "defs");
			const glow = document.createElementNS(SVG_NS, "filter");
			glow.setAttribute("id", "glow");
			const blur = document.createElementNS(SVG_NS, "feGaussianBlur");
			blur.setAttribute("stdDeviation", "0.4");
			blur.setAttribute("result", "coloredBlur");
			const merge = document.createElementNS(SVG_NS, "feMerge");
			const mn1 = document.createElementNS(SVG_NS, "feMergeNode");
			mn1.setAttribute("in", "coloredBlur");
			const mn2 = document.createElementNS(SVG_NS, "feMergeNode");
			mn2.setAttribute("in", "SourceGraphic");
			merge.appendChild(mn1);
			merge.appendChild(mn2);
			glow.appendChild(blur);
			glow.appendChild(merge);
			defs.appendChild(glow);
			const shadow = document.createElementNS(SVG_NS, "filter");
			shadow.setAttribute("id", "shadow");
			const ds = document.createElementNS(SVG_NS, "feDropShadow");
			ds.setAttribute("dx", "0");
			ds.setAttribute("dy", "0.2");
			ds.setAttribute("stdDeviation", "0.3");
			ds.setAttribute("flood-opacity", "0.3");
			shadow.appendChild(ds);
			defs.appendChild(shadow);
			return defs;
		}
		buildMusclePath(muscle) {
			const path = document.createElementNS(SVG_NS, "path");
			path.setAttribute("d", muscle.path);
			path.classList.add("body-chart-muscle");
			path.setAttribute("role", "button");
			path.setAttribute("tabindex", "0");
			const title = document.createElementNS(SVG_NS, "title");
			title.textContent = muscle.name;
			path.appendChild(title);
			const onEnter = () => {
				this.hoveredMuscle = muscle.id;
				this.options.onMuscleHover(muscle.id);
				this.refreshPath(muscle.id);
			};
			const onLeave = () => {
				const prev = this.hoveredMuscle;
				this.hoveredMuscle = null;
				this.options.onMuscleHover(null);
				if (prev) this.refreshPath(prev);
			};
			const onClick = () => {
				this.options.onMuscleClick(muscle.id, muscle.name);
			};
			const onKeyDown = (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					this.options.onMuscleClick(muscle.id, muscle.name);
				}
			};
			path.addEventListener("mouseenter", onEnter);
			path.addEventListener("mouseleave", onLeave);
			path.addEventListener("click", onClick);
			path.addEventListener("keydown", onKeyDown);
			this.eventCleanup.push(() => {
				path.removeEventListener("mouseenter", onEnter);
				path.removeEventListener("mouseleave", onLeave);
				path.removeEventListener("click", onClick);
				path.removeEventListener("keydown", onKeyDown);
			});
			return path;
		}
		refreshAllPaths() {
			for (const id of this.musclePaths.keys()) this.refreshPath(id);
		}
		refreshPath(muscleId) {
			const path = this.musclePaths.get(muscleId);
			if (!path) return;
			const state = this.options.bodyState[muscleId] || {
				intensity: 0,
				selected: false
			};
			const isSelected = state.selected || false;
			const isHovered = this.hoveredMuscle === muscleId;
			const fill = getMuscleColor(state, isHovered);
			const opacity = state.intensity === 0 && !isSelected ? .6 : 1;
			const muscle = this.muscleData.find((m) => m.id === muscleId);
			path.setAttribute("fill", fill);
			path.setAttribute("stroke", isSelected ? "#ffffff" : "#1e293b");
			path.setAttribute("stroke-width", isSelected ? "0.3" : "0.1");
			path.setAttribute("aria-label", `${muscle?.name || muscleId}${isSelected ? " (selected)" : ""}${state.intensity > 0 ? ` - intensity ${state.intensity}` : ""}`);
			path.style.fillOpacity = String(opacity);
			path.style.filter = isSelected || isHovered ? "url(#glow)" : "none";
			path.style.cursor = "pointer";
			path.style.transition = this.options.enableTransitions ? "all 200ms ease-out" : "none";
			path.style.outline = "none";
		}
		buildViewLabel(view) {
			const el = document.createElement("div");
			el.className = "body-chart-view-label";
			el.setAttribute("aria-hidden", "true");
			setStyles(el, {
				position: "absolute",
				bottom: "1rem",
				left: "50%",
				transform: "translateX(-50%)",
				color: "#64748b",
				fontSize: "0.875rem",
				fontFamily: "monospace",
				letterSpacing: "0.1em",
				textTransform: "uppercase",
				pointerEvents: "none",
				backgroundColor: "rgba(15, 23, 42, 0.5)",
				padding: "0.25rem 0.75rem",
				borderRadius: "9999px",
				backdropFilter: "blur(4px)",
				zIndex: "10"
			});
			el.textContent = `${view === ViewSide.FRONT ? "Anterior" : "Posterior"} View`;
			return el;
		}
	};
	function setStyles(el, styles) {
		for (const [k, v] of Object.entries(styles)) el.style[k] = v;
	}
	//#endregion
	//#region src/muscleView.js
	/**
	* 肌肉可视化封装 —— 调用开源库 body-muscles（Apache-2.0，零依赖 SVG）。
	* 老师要求「调现成库、别自己画解剖图」，这里就是那一层薄封装。
	*
	* 关键点：深蹲的主要肌群分布在身体「前面」（股四头肌）和「背面」（臀大肌、腘绳肌），
	* body-muscles 的 FRONT / BACK 是两套独立 SVG，所以我们并排渲染两张图，
	* 前后视图同时随动作高亮。
	*
	* 库 API：
	*   new BodyChart(containerEl, { view, bodyState })
	*   chart.update({ bodyState })   // 局部更新颜色
	* bodyState 形如 { "quads-left": { intensity: 0~10, selected: true } }
	*/
	function createMuscleView(frontContainer, backContainer) {
		const frontChart = new BodyChart(frontContainer, {
			view: ViewSide.FRONT,
			bodyState: {},
			showViewLabel: true
		});
		const backChart = new BodyChart(backContainer, {
			view: ViewSide.BACK,
			bodyState: {},
			showViewLabel: true
		});
		/**
		* 把「动作的肌群定义 + 当前强度(0~1)」映射成 body-muscles 的 bodyState 并刷新。
		* @param {{front: Array<{id,weight}>, back: Array<{id,weight}>}} muscleGroups 动作涉及的肌群
		* @param {number} intensity01 当前发力强度 0~1（深蹲用蹲的深度 depthRatio）
		*/
		function highlight(muscleGroups, intensity01) {
			frontChart.update({ bodyState: buildState(muscleGroups.front, intensity01) });
			backChart.update({ bodyState: buildState(muscleGroups.back, intensity01) });
		}
		/** 清空高亮（回到灰色静息态）。 */
		function clear() {
			frontChart.update({ bodyState: {} });
			backChart.update({ bodyState: {} });
		}
		return {
			highlight,
			clear
		};
	}
	/**
	* 由肌群列表 + 强度生成 bodyState。
	* 映射：基础亮度 0.2 + 0.8×强度，再乘以该肌肉的发力权重，缩放到 1~10。
	* 这样静息时也微微可见，发力越深越红。
	*/
	function buildState(muscles, intensity01) {
		const state = {};
		const base = .2 + .8 * clamp01(intensity01);
		for (const { id, weight } of muscles) {
			const level = Math.round(base * weight * 10);
			state[id] = {
				intensity: Math.min(Math.max(level, 1), 10),
				selected: false
			};
		}
		return state;
	}
	function clamp01(v) {
		return Math.min(Math.max(v, 0), 1);
	}
	//#endregion
	//#region src/feedback.js
	/**
	* 教练反馈生成 —— 第二阶段：本地 LLM（Ollama）+ 模板话术双轨。
	*
	* 分工不变（AGENT.md 铁律）：
	*   - 规则引擎（exercises/*.js）判对错，给结构化数据（次数 / cues / 深度统计）。
	*   - 本文件只负责「把事实说成人话」：
	*       · 即时反馈（每次动作完成）→ 模板话术，零延迟、零依赖；
	*       · 组总结 → 优先调本地 Ollama（OpenAI 兼容接口）生成口语化点评，
	*         Ollama 不可用 / 超时 / 返回异常时**无缝降级**回模板话术，UI 永不报错。
	*   - 绝不让 LLM 自己判断动作对错（小模型会幻觉夸错），Prompt 里只给规则引擎的结论。
	*/
	var OLLAMA_URL = "http://localhost:11434/v1/chat/completions";
	var OLLAMA_MODEL = "qwen3:4b";
	var LLM_TIMEOUT_MS = 8e3;
	/** 中文「错误标签 → 即时提示语」对照表（规则引擎输出 cue，这里翻译）。 */
	var CUE_TEXT = {
		shallow: "蹲得还不够深，试着让大腿更接近与地面平行。",
		valgus: "注意膝盖别向内扣，让膝盖对准脚尖方向。",
		arms_low: "手臂要完全举过头顶，在头顶上方合拢再放下。",
		narrow: "双脚跳开的幅度再大一点，明显超过肩宽。"
	};
	/** 中文「错误标签 → 简短规则名」，喂给 LLM 的事实描述用（比整句提示语更省 token）。 */
	var CUE_NAME = {
		shallow: "蹲得不够深",
		valgus: "膝盖内扣",
		arms_low: "手臂未举过头顶",
		narrow: "双脚张开幅度不足"
	};
	var PRAISE = [
		"标准！保持这个节奏 💪",
		"很棒，动作很到位 👍",
		"漂亮，核心稳住了！",
		"完美的一次！"
	];
	/**
	* 单次动作完成后的即时反馈（模板，零延迟——每次动作都调 LLM 既慢又没必要）。
	* @param {{index:number, cues:string[], good:boolean}} rep 规则引擎给的 lastRep
	* @returns {{text:string, good:boolean}}
	*/
	function repFeedback(rep) {
		if (rep.good) {
			const praise = PRAISE[rep.index % PRAISE.length];
			return {
				text: `第 ${rep.index} 次：${praise}`,
				good: true
			};
		}
		const tips = rep.cues.map((c) => CUE_TEXT[c] ?? c).join(" ");
		return {
			text: `第 ${rep.index} 次：${tips}`,
			good: false
		};
	}
	/** 把 cue 标签翻译成「语音播报用」的短句（不带次数前缀，方便防刷屏去重）。 */
	function cueSpeechText(cues) {
		return cues.map((c) => CUE_TEXT[c] ?? c).join("");
	}
	/**
	* 一组练完后的总结反馈 —— 模板版（LLM 不可用时的降级话术，也用作即时占位）。
	* @param {{exercise?:string, total:number, goodCount:number}} stats
	*/
	function setSummary({ exercise = "深蹲", total, goodCount }) {
		if (total === 0) return `还没开始，正对摄像头做几个${exercise}试试吧！`;
		const rate = Math.round(goodCount / total * 100);
		if (rate >= 80) return `本组${exercise}共 ${total} 次，其中 ${goodCount} 次标准（${rate}%）。完成度很高，下次可以尝试增加次数或放慢速度提高质量。`;
		if (rate >= 50) return `本组${exercise}共 ${total} 次，标准 ${goodCount} 次（${rate}%）。基础不错，重点改进上面提示的动作要点。`;
		return `本组${exercise}共 ${total} 次，标准 ${goodCount} 次（${rate}%）。先放慢速度，把每一次都做到位再加量。`;
	}
	/**
	* qwen3 系列默认会输出 <think>…</think> 思考段，展示前剥离。
	* 兼容「没闭合的 <think>」（被 max_tokens 截断时）：此时整段都是思考，返回空串走降级。
	*/
	function stripThink(text) {
		if (!text) return "";
		let out = text.replace(/<think>[\s\S]*?<\/think>/g, "");
		const open = out.indexOf("<think>");
		if (open !== -1) out = out.slice(0, open);
		return out.trim();
	}
	/** 把本组结构化数据拼成给 LLM 的中文事实描述（只给结论，不让它自己判对错）。 */
	function buildSetPrompt({ exercise, total, goodCount, cueCounts, metricLabel, metricAvg }) {
		const lines = [`动作：${exercise}`, `总次数：${total}，其中标准 ${goodCount} 次`];
		const cueLines = Object.entries(cueCounts ?? {}).filter(([, n]) => n > 0).map(([cue, n]) => `${CUE_NAME[cue] ?? cue} ×${n}`);
		lines.push(cueLines.length ? `规则引擎判出的问题：${cueLines.join("、")}` : "规则引擎未发现动作问题");
		if (metricLabel && metricAvg != null) lines.push(`深度统计：本组平均${metricLabel} = ${metricAvg}`);
		return lines.join("\n");
	}
	var SYSTEM_PROMPT = [
		"你是一名专业、亲切的中文健身教练。",
		"用户刚完成一组训练，下面给你的是动作识别系统（规则引擎）已经判定好的事实数据。",
		"请基于这些事实，用口语化的中文给出 2-3 句简短建议：先肯定做得好的地方，再针对出现的问题给出最重要的一条改进要点。",
		"要求：不要复述数字列表，不要使用 Markdown 或表情符号，不要自己推测数据之外的问题，总长度不超过 80 字。"
	].join("");
	/**
	* 调本地 Ollama 生成本组训练的教练点评。
	* 任何失败（连不上 / 超时 / 返回格式异常 / 剥离思考段后为空）都返回 null，
	* 由调用方降级到 setSummary() 模板——UI 永远有话可说、永不报错。
	*
	* @param {{exercise:string, total:number, goodCount:number,
	*          cueCounts:Object<string,number>, metricLabel?:string, metricAvg?:string|number}} setData
	* @returns {Promise<string|null>}
	*/
	async function llmSetSummary(setData) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
		try {
			const res = await fetch(OLLAMA_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				signal: controller.signal,
				body: JSON.stringify({
					model: OLLAMA_MODEL,
					messages: [{
						role: "system",
						content: SYSTEM_PROMPT
					}, {
						role: "user",
						content: buildSetPrompt(setData)
					}],
					temperature: .7,
					max_tokens: 1024,
					stream: false
				})
			});
			if (!res.ok) return null;
			const raw = (await res.json())?.choices?.[0]?.message?.content;
			return stripThink(raw) || null;
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
		}
	}
	//#endregion
	//#region src/speech.js
	/**
	* 语音播报 —— 浏览器自带 Web Speech API（speechSynthesis），零依赖、离线可用。
	*
	* 设计要点：
	*   - 计数播报（"5"）短促高频 → 标记为 skippable：引擎正忙时直接跳过，不排队，
	*     否则快速连做几次后语音会越积越多、和画面脱节。
	*   - 纠错提示防刷屏：同一条提示在 DEDUPE_MS 内只播一次（连续好几次都内扣时不会每次都念一遍）。
	*   - 浏览器不支持 speechSynthesis 时整体静默（supported=false），UI 可据此禁用开关。
	*/
	var DEDUPE_MS = 6e3;
	function createSpeaker() {
		const supported = typeof window !== "undefined" && "speechSynthesis" in window;
		let enabled = true;
		const lastSpokenAt = /* @__PURE__ */ new Map();
		/**
		* 播报一段中文。
		* @param {string} text
		* @param {{dedupeKey?:string, dedupeMs?:number, skippable?:boolean}} opts
		*   - dedupeKey：去重键，相同键在 dedupeMs 内不重复播报（用于纠错提示防刷屏）
		*   - skippable：引擎正在说话时直接放弃（用于计数，宁可漏报不要积压）
		*/
		function speak(text, { dedupeKey = null, dedupeMs = DEDUPE_MS, skippable = false } = {}) {
			if (!supported || !enabled || !text) return;
			if (skippable && (speechSynthesis.speaking || speechSynthesis.pending)) return;
			if (dedupeKey) {
				const now = Date.now();
				if (now - (lastSpokenAt.get(dedupeKey) ?? -Infinity) < dedupeMs) return;
				lastSpokenAt.set(dedupeKey, now);
			}
			const u = new SpeechSynthesisUtterance(text);
			u.lang = "zh-CN";
			u.rate = 1.1;
			speechSynthesis.speak(u);
		}
		/** 开/关播报；关闭时立即打断当前语音。 */
		function setEnabled(on) {
			enabled = !!on;
			if (!enabled && supported) speechSynthesis.cancel();
		}
		return {
			supported,
			speak,
			setEnabled,
			isEnabled: () => enabled
		};
	}
	//#endregion
	//#region src/history.js
	/**
	* 训练历史 —— localStorage 持久化，纯数据层（渲染在 main.js）。
	*
	* 一条记录 = 一组训练（从开始计数到 停止/重置/切换动作 为止）：
	*   { time: ISO 字符串, exercise: "深蹲", total: 12, good: 9, cues: { shallow: 2, valgus: 1 } }
	*
	* 设计要点：
	*   - localStorage 在隐私模式/被禁用时会抛异常，所有读写都包 try/catch，坏了就当没有历史，不影响训练主流程。
	*   - 最多存 MAX_RECORDS 条（够算累计统计），UI 只展示最近 10 条。
	*/
	var KEY = "coach.history.v1";
	var MAX_RECORDS = 50;
	/** 读出全部历史（新→旧）。读不到/解析失败一律返回空数组。 */
	function loadHistory() {
		try {
			const raw = localStorage.getItem(KEY);
			const arr = raw ? JSON.parse(raw) : [];
			return Array.isArray(arr) ? arr : [];
		} catch {
			return [];
		}
	}
	/**
	* 追加一条训练记录（插到最前，新→旧），返回最新的完整历史。
	* @param {{time:string, exercise:string, total:number, good:number, cues:Object<string,number>}} record
	*/
	function addRecord(record) {
		const records = loadHistory();
		records.unshift(record);
		if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;
		try {
			localStorage.setItem(KEY, JSON.stringify(records));
		} catch {}
		return records;
	}
	/** 清空全部历史。 */
	function clearHistory() {
		try {
			localStorage.removeItem(KEY);
		} catch {}
	}
	/**
	* 累计统计：组数、总次数、标准次数、各纠错规则累计触发次数。
	* @param {Array} records loadHistory() 的返回值
	*/
	function aggregate(records) {
		const agg = {
			sets: records.length,
			reps: 0,
			goodReps: 0,
			cueTotals: {}
		};
		for (const r of records) {
			agg.reps += r.total ?? 0;
			agg.goodReps += r.good ?? 0;
			for (const [cue, n] of Object.entries(r.cues ?? {})) agg.cueTotals[cue] = (agg.cueTotals[cue] ?? 0) + n;
		}
		return agg;
	}
	var W$1 = 640;
	var H$1 = 480;
	/** 示例片段清单（顺序即下拉框顺序）。peak 等参数决定最低膝角 / 张开峰值，见 results/result.json。 */
	var CLIPS = [
		{
			id: "squat_good",
			exercise: "squat",
			name: "深蹲 · 标准（5 次）",
			note: "膝盖对准脚尖、蹲到大腿接近水平。标准档全部通过；换成「严格」档会出现「不够深」。",
			reps: 5,
			params: {
				depth: 1,
				kneeOut: 34,
				stance: 26
			}
		},
		{
			id: "squat_shallow",
			exercise: "squat",
			name: "深蹲 · 蹲太浅（4 次）",
			note: "每次只蹲到一半就站起来。标准档判「不够深」；换成「宽松」档就算通过。",
			reps: 4,
			params: {
				depth: .93,
				kneeOut: 34,
				stance: 26
			}
		},
		{
			id: "squat_valgus",
			exercise: "squat",
			name: "深蹲 · 膝盖内扣（4 次）",
			note: "蹲得够深，但两膝向内夹。看右栏「本次判定依据」：膝距/踝距低于阈值。换成「宽松」档就算通过。",
			reps: 4,
			params: {
				depth: 1.08,
				kneeOut: -12,
				stance: 48,
				hipW: 36
			}
		},
		{
			id: "squat_cropped",
			exercise: "squat",
			name: "深蹲 · 脚出了画面（不计数）",
			note: "离镜头太近，脚踝在画面外，姿态网络给出的可见度很低。规则宁可不计数也不乱判。",
			reps: 3,
			params: {
				depth: 1,
				kneeOut: 34,
				stance: 26,
				cropped: true
			}
		},
		{
			id: "jj_good",
			exercise: "jumpingJack",
			name: "开合跳 · 标准（6 次）",
			note: "跳开超过肩宽、双手在头顶上方合拢。标准档全部通过；「严格」档会嫌跳得不够开。",
			reps: 6,
			params: {
				open: .97,
				armMax: 168
			}
		},
		{
			id: "jj_arms_low",
			exercise: "jumpingJack",
			name: "开合跳 · 手没举过头顶（5 次）",
			note: "腿跳开了，但手只抬到肩膀高度。这条规则看的是「双腕是否高于鼻子」，没有阈值可调。",
			reps: 5,
			params: {
				open: .97,
				armMax: 95
			}
		},
		{
			id: "jj_narrow",
			exercise: "jumpingJack",
			name: "开合跳 · 腿没跳开（5 次）",
			note: "手举过头了，但双脚只张开一点。标准档判「张开不足」；「宽松」档算通过。",
			reps: 5,
			params: {
				open: .8,
				armMax: 168
			}
		}
	];
	function getClipMeta(id) {
		return CLIPS.find((c) => c.id === id) ?? null;
	}
	/** 确定性伪随机数（mulberry32）。 */
	function rng(seed) {
		let a = seed >>> 0;
		return () => {
			a = a + 1831565813 >>> 0;
			let t = a;
			t = Math.imul(t ^ t >>> 15, t | 1);
			t ^= t + Math.imul(t ^ t >>> 7, t | 61);
			return ((t ^ t >>> 14) >>> 0) / 4294967296;
		};
	}
	function hashStr(s) {
		let h = 2166136261;
		for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
		return h >>> 0;
	}
	var lerp = (a, b, t) => a + (b - a) * t;
	var ease = (t) => (1 - Math.cos(Math.PI * Math.min(Math.max(t, 0), 1))) / 2;
	/**
	* 由姿态参数生成 33 个像素坐标点。
	* @param {object} p
	*   cx, ty           身体中心 x、整体上下偏移（跳跃）
	*   d                下蹲程度 0~1
	*   kneeOut          蹲到底时膝盖向外移动的像素（负数 = 向内扣）
	*   stance           脚踝半间距（像素）
	*   armFwd           深蹲时手臂前平举程度 0~1
	*   armAngle         开合跳手臂外展角（度，0=自然下垂，180=竖直向上）；null 表示用 armFwd
	*   scale, oy        画面缩放与下移（用于「离镜头太近」）
	*/
	function bodyPixels(p) {
		const { cx = 320, ty = 0, d = 0, kneeOut = 0, stance = 24, hipW = 20, armFwd = 0, armAngle = null } = p;
		const pts = new Array(33);
		const hipDrop = 74 * d;
		const torsoDrop = 84 * d;
		const sy = 152 + torsoDrop + ty;
		const hy = 268 + hipDrop + ty;
		const ky = 350 + 4 * d + ty;
		const ay = 432 + ty;
		const headY = 98 + torsoDrop + ty;
		pts[0] = [cx, headY];
		pts[1] = [cx + 6, headY - 8];
		pts[2] = [cx + 10, headY - 8];
		pts[3] = [cx + 14, headY - 8];
		pts[4] = [cx - 6, headY - 8];
		pts[5] = [cx - 10, headY - 8];
		pts[6] = [cx - 14, headY - 8];
		pts[7] = [cx + 22, headY - 4];
		pts[8] = [cx - 22, headY - 4];
		pts[9] = [cx + 6, headY + 10];
		pts[10] = [cx - 6, headY + 10];
		for (const side of [1, -1]) {
			const L = side === 1;
			const sh = [cx + side * 36, sy];
			let el;
			let wr;
			if (armAngle != null) {
				const th = armAngle * Math.PI / 180;
				const dir = [side * Math.sin(th), Math.cos(th)];
				el = [sh[0] + dir[0] * 62, sh[1] + dir[1] * 62];
				wr = [sh[0] + dir[0] * 120, sh[1] + dir[1] * 120];
			} else {
				el = [sh[0] + side * lerp(6, -4, armFwd), sh[1] + lerp(62, 18, armFwd)];
				wr = [sh[0] + side * lerp(8, -10, armFwd), sh[1] + lerp(120, 22, armFwd)];
			}
			const hip = [cx + side * (hipW + 6 * d), hy];
			const knee = [cx + side * (22 + kneeOut * d + (stance - 24) * .6), ky];
			const ank = [cx + side * stance, ay];
			const i = (l, r) => L ? l : r;
			pts[i(11, 12)] = sh;
			pts[i(13, 14)] = el;
			pts[i(15, 16)] = wr;
			pts[i(17, 18)] = [wr[0] + side * 5, wr[1] + 10];
			pts[i(19, 20)] = [wr[0] + side * 1, wr[1] + 12];
			pts[i(21, 22)] = [wr[0] - side * 4, wr[1] + 8];
			pts[i(23, 24)] = hip;
			pts[i(25, 26)] = knee;
			pts[i(27, 28)] = ank;
			pts[i(29, 30)] = [ank[0], ank[1] + 8];
			pts[i(31, 32)] = [ank[0] + side * 5, ank[1] + 16];
		}
		return pts;
	}
	/** 像素点 → MediaPipe 风格的归一化关键点，并加入很小的抖动和可见度。 */
	function toLandmarks(pts, rand, { scale = 1, oy = 0, lowVis = null } = {}) {
		return pts.map(([x, y], idx) => {
			const jx = (rand() - .5) * 1.6;
			const jy = (rand() - .5) * 1.6;
			const X = 320 + (x - 320) * scale + jx;
			const Y = oy + y * scale + jy;
			let vis = .93 + rand() * .06;
			if (lowVis && lowVis.has(idx)) vis = .05 + rand() * .1;
			if (X < 0 || X > W$1 || Y < 0 || Y > H$1) vis = Math.min(vis, .12);
			return {
				x: Number((X / W$1).toFixed(4)),
				y: Number((Y / H$1).toFixed(4)),
				z: 0,
				visibility: Number(vis.toFixed(3))
			};
		});
	}
	/** 深蹲：每次 2.4 秒（下 1.0 s、底部停 0.2 s、起 1.0 s、站 0.2 s）。返回每帧的 d。 */
	function squatTimeline(reps, peaks) {
		const out = [];
		const hold = (n, v) => {
			for (let i = 0; i < n; i++) out.push(v);
		};
		hold(30, 0);
		for (let r = 0; r < reps; r++) {
			const pk = peaks[r];
			for (let i = 0; i < 30; i++) out.push(pk * ease(i / 29));
			hold(6, pk);
			for (let i = 0; i < 30; i++) out.push(pk * (1 - ease(i / 29)));
			hold(6, 0);
		}
		hold(30, 0);
		return out;
	}
	/** 开合跳：每次 1.0 秒，张开程度按余弦曲线 0→峰值→0。 */
	function jackTimeline(reps, peaks) {
		const out = [];
		const hold = (n, v) => {
			for (let i = 0; i < n; i++) out.push(v);
		};
		hold(30, 0);
		for (let r = 0; r < reps; r++) {
			const pk = peaks[r];
			for (let i = 0; i < 30; i++) out.push(pk * (1 - Math.cos(2 * Math.PI * i / 30)) / 2);
		}
		hold(30, 0);
		return out;
	}
	var cache = /* @__PURE__ */ new Map();
	/**
	* 生成片段的全部帧。
	* @param {string} id CLIPS 里的 id
	* @returns {{meta: object, fps: number, frames: Array<Array<{x,y,z,visibility}>>}}
	*/
	function generateClip(id) {
		if (cache.has(id)) return cache.get(id);
		const meta = getClipMeta(id);
		if (!meta) throw new Error(`未知片段：${id}`);
		const clip = buildClip(meta);
		cache.set(id, clip);
		return clip;
	}
	/** 按片段描述生成帧（generateClip 的实际实现；单独导出便于调参）。 */
	function buildClip(meta) {
		const id = meta.id;
		const rand = rng(hashStr(id));
		const P = meta.params;
		const peaks = Array.from({ length: meta.reps }, () => P.depth ?? P.open);
		for (let r = 0; r < peaks.length; r++) peaks[r] *= .985 + rand() * .03;
		const frames = [];
		if (meta.exercise === "squat") {
			const tl = squatTimeline(meta.reps, peaks);
			const lowVis = P.cropped ? new Set([
				25,
				26,
				27,
				28,
				29,
				30,
				31,
				32
			]) : null;
			for (const d of tl) {
				const pts = bodyPixels({
					d,
					kneeOut: P.kneeOut,
					stance: P.stance,
					hipW: P.hipW,
					armFwd: Math.min(1, d * 1.3)
				});
				frames.push(toLandmarks(pts, rand, P.cropped ? {
					scale: 1.45,
					oy: -40,
					lowVis
				} : {}));
			}
		} else {
			const tl = jackTimeline(meta.reps, peaks);
			for (const o of tl) {
				const stance = lerp(20, 64, o);
				const armAngle = lerp(12, P.armMax, Math.min(1, o / Math.max(P.open, .01)));
				const pts = bodyPixels({
					d: 0,
					stance,
					kneeOut: 0,
					ty: -10 * Math.sin(Math.PI * Math.min(1, o / Math.max(P.open, .01))),
					armAngle
				});
				for (const [k, a] of [[25, 27], [26, 28]]) pts[k] = [lerp(pts[k][0], pts[a][0], .55), pts[k][1]];
				frames.push(toLandmarks(pts, rand));
			}
		}
		return {
			meta,
			fps: 30,
			frames
		};
	}
	//#endregion
	//#region play_src/presets.js
	/**
	* presets.js —— 「判定严格度」预设档位 + 细调滑块的定义。
	*
	* 只改判定阈值，不改规则本身。数值都会原样传给
	* createSquatExercise(overrides) / createJumpingJackExercise(overrides)。
	* 「标准」档 = 规则文件里的默认值（SQUAT_DEFAULTS / JUMPING_JACK_DEFAULTS）。
	*/
	var PRESET_ORDER = [
		"loose",
		"standard",
		"strict",
		"custom"
	];
	var PRESET_LABELS = {
		loose: "宽松",
		standard: "标准",
		strict: "严格",
		custom: "自定义"
	};
	/** 每档的一句话说明（显示在档位按钮下方）。 */
	var PRESET_DESC = {
		squat: {
			loose: "新手档：膝角低于 115° 就算蹲到位，膝距/踝距不低于 0.45 就不算内扣。",
			standard: "默认档：膝角低于 105° 算蹲到位，膝距/踝距低于 0.55 判内扣。",
			strict: "严格档：要蹲到膝角低于 95°，膝距/踝距低于 0.65 就判内扣。",
			custom: "自定义：用下面的滑块逐项调阈值。"
		},
		jumpingJack: {
			loose: "新手档：踝距达到肩宽的 1.45 倍就算跳开到位。",
			standard: "默认档：踝距要达到肩宽的 1.6 倍。",
			strict: "严格档：踝距要达到肩宽的 1.8 倍。",
			custom: "自定义：用下面的滑块逐项调阈值。"
		}
	};
	var PRESETS = {
		squat: {
			loose: {
				shallowAngle: 115,
				valgusRatio: .45
			},
			standard: {},
			strict: {
				shallowAngle: 95,
				valgusRatio: .65
			}
		},
		jumpingJack: {
			loose: { fullSpread: 1.45 },
			standard: {},
			strict: { fullSpread: 1.8 }
		}
	};
	var DEFAULTS = {
		squat: SQUAT_DEFAULTS,
		jumpingJack: JUMPING_JACK_DEFAULTS
	};
	/** 细调滑块：key 对应 overrides 的字段。 */
	var SLIDERS = {
		squat: [
			{
				key: "downAngle",
				label: "下蹲线：膝角低于它进入「下蹲」",
				min: 110,
				max: 150,
				step: 1,
				unit: "°"
			},
			{
				key: "upAngle",
				label: "站起线：膝角高于它算「站起」并计数",
				min: 140,
				max: 175,
				step: 1,
				unit: "°"
			},
			{
				key: "shallowAngle",
				label: "蹲深线：最低膝角高于它判「不够深」",
				min: 80,
				max: 125,
				step: 1,
				unit: "°"
			},
			{
				key: "valgusRatio",
				label: "内扣线：膝距/踝距低于它判「膝盖内扣」",
				min: .3,
				max: .9,
				step: .01,
				unit: ""
			}
		],
		jumpingJack: [
			{
				key: "openRatio",
				label: "张开线：踝距/肩宽高于它进入「张开」",
				min: 1.1,
				max: 1.6,
				step: .01,
				unit: "×"
			},
			{
				key: "closeRatio",
				label: "并拢线：踝距/肩宽低于它算「并拢」并计数",
				min: .7,
				max: 1.2,
				step: .01,
				unit: "×"
			},
			{
				key: "fullSpread",
				label: "到位线：张开峰值低于它判「张开不足」",
				min: 1.3,
				max: 2.1,
				step: .01,
				unit: "×"
			}
		]
	};
	/** 取某个动作某一档的完整阈值（默认值 + 档位覆盖）。 */
	function thresholdsFor(exercise, preset, custom = null) {
		const base = { ...DEFAULTS[exercise] };
		if (preset === "custom" && custom) return {
			...base,
			...custom
		};
		return {
			...base,
			...PRESETS[exercise][preset] ?? {}
		};
	}
	//#endregion
	//#region node_modules/@mediapipe/tasks-vision/vision_bundle.mjs
	var t = "undefined" != typeof self ? self : {};
	function e(e, n) {
		t: {
			for (var r = ["CLOSURE_FLAGS"], i = t, s = 0; s < r.length; s++) if (null == (i = i[r[s]])) {
				r = null;
				break t;
			}
			r = i;
		}
		return null != (e = r && r[e]) ? e : n;
	}
	function n() {
		throw Error("Invalid UTF8");
	}
	function r(t, e) {
		return e = String.fromCharCode.apply(null, e), null == t ? e : t + e;
	}
	var i, s;
	var o = "undefined" != typeof TextDecoder;
	var a;
	var c = "undefined" != typeof TextEncoder;
	function h(t) {
		if (c) t = (a || (a = new TextEncoder())).encode(t);
		else {
			let n = 0;
			const r = new Uint8Array(3 * t.length);
			for (let i = 0; i < t.length; i++) {
				var e = t.charCodeAt(i);
				if (e < 128) r[n++] = e;
				else {
					if (e < 2048) r[n++] = e >> 6 | 192;
					else {
						if (e >= 55296 && e <= 57343) {
							if (e <= 56319 && i < t.length) {
								const s = t.charCodeAt(++i);
								if (s >= 56320 && s <= 57343) {
									e = 1024 * (e - 55296) + s - 56320 + 65536, r[n++] = e >> 18 | 240, r[n++] = e >> 12 & 63 | 128, r[n++] = e >> 6 & 63 | 128, r[n++] = 63 & e | 128;
									continue;
								}
								i--;
							}
							e = 65533;
						}
						r[n++] = e >> 12 | 224, r[n++] = e >> 6 & 63 | 128;
					}
					r[n++] = 63 & e | 128;
				}
			}
			t = n === r.length ? r : r.subarray(0, n);
		}
		return t;
	}
	function u(e) {
		t.setTimeout((() => {
			throw e;
		}), 0);
	}
	var l, f = e(610401301, !1), d = e(748402147, !0);
	function p() {
		var e = t.navigator;
		return e && (e = e.userAgent) ? e : "";
	}
	var g = t.navigator;
	function m(t) {
		return m[" "](t), t;
	}
	l = g && g.userAgentData || null, m[" "] = function() {};
	var y = {};
	var _ = null;
	function v(t) {
		const e = t.length;
		let n = 3 * e / 4;
		n % 3 ? n = Math.floor(n) : -1 != "=.".indexOf(t[e - 1]) && (n = -1 != "=.".indexOf(t[e - 2]) ? n - 2 : n - 1);
		const r = new Uint8Array(n);
		let i = 0;
		return function(t, e) {
			function n(e) {
				for (; r < t.length;) {
					const e = t.charAt(r++), n = _[e];
					if (null != n) return n;
					if (!/^[\s\xa0]*$/.test(e)) throw Error("Unknown base64 encoding at char: " + e);
				}
				return e;
			}
			E();
			let r = 0;
			for (;;) {
				const t = n(-1), r = n(0), i = n(64), s = n(64);
				if (64 === s && -1 === t) break;
				e(t << 2 | r >> 4), 64 != i && (e(r << 4 & 240 | i >> 2), 64 != s && e(i << 6 & 192 | s));
			}
		}(t, (function(t) {
			r[i++] = t;
		})), i !== n ? r.subarray(0, i) : r;
	}
	function E() {
		if (!_) {
			_ = {};
			var t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".split(""), e = [
				"+/=",
				"+/",
				"-_=",
				"-_.",
				"-_"
			];
			for (let n = 0; n < 5; n++) {
				const r = t.concat(e[n].split(""));
				y[n] = r;
				for (let t = 0; t < r.length; t++) {
					const e = r[t];
					void 0 === _[e] && (_[e] = t);
				}
			}
		}
	}
	var w = "undefined" != typeof Uint8Array, T = !(!(f && l && l.brands.length > 0) && (-1 != p().indexOf("Trident") || -1 != p().indexOf("MSIE"))) && "function" == typeof btoa;
	var A = /[-_.]/g, b = {
		"-": "+",
		_: "/",
		".": "="
	};
	function k(t) {
		return b[t] || "";
	}
	function S$1(t) {
		if (!T) return v(t);
		t = A.test(t) ? t.replace(A, k) : t, t = atob(t);
		const e = new Uint8Array(t.length);
		for (let n = 0; n < t.length; n++) e[n] = t.charCodeAt(n);
		return e;
	}
	function x(t) {
		return w && null != t && t instanceof Uint8Array;
	}
	var L = {};
	function R() {
		return M || (M = new F(null, L));
	}
	function I(t) {
		C(L);
		var e = t.g;
		return null == (e = null == e || x(e) ? e : "string" == typeof e ? S$1(e) : null) ? e : t.g = e;
	}
	var F = class {
		h() {
			return new Uint8Array(I(this) || 0);
		}
		constructor(t, e) {
			if (C(e), this.g = t, null != t && 0 === t.length) throw Error("ByteString should be constructed with non-empty values");
		}
	};
	var M, P;
	function C(t) {
		if (t !== L) throw Error("illegal external caller");
	}
	function O(t, e) {
		t.__closure__error__context__984382 || (t.__closure__error__context__984382 = {}), t.__closure__error__context__984382.severity = e;
	}
	function N(t) {
		return O(t = Error(t), "warning"), t;
	}
	function U(t, e) {
		if (null != t) {
			var n = P ?? (P = {}), r = n[t] || 0;
			r >= e || (n[t] = r + 1, O(t = Error(), "incident"), u(t));
		}
	}
	function D() {
		return "function" == typeof BigInt;
	}
	var B = "function" == typeof Symbol && "symbol" == typeof Symbol();
	function G(t, e, n = !1) {
		return "function" == typeof Symbol && "symbol" == typeof Symbol() ? n && Symbol.for && t ? Symbol.for(t) : null != t ? Symbol(t) : Symbol() : e;
	}
	var j = G("jas", void 0, !0), V = G(void 0, "0di"), X = G(void 0, "1oa"), H = G(void 0, Symbol()), W = G(void 0, "0ub"), z = G(void 0, "0ubs"), K = G(void 0, "0ubsb"), Y = G(void 0, "0actk"), q = G("m_m", "Pa", !0), $$1 = G();
	var J = { Ga: {
		value: 0,
		configurable: !0,
		writable: !0,
		enumerable: !1
	} }, Z = Object.defineProperties, Q = B ? j : "Ga";
	var tt;
	var et = [];
	function nt(t, e) {
		B || Q in t || Z(t, J), t[Q] |= e;
	}
	function rt(t, e) {
		B || Q in t || Z(t, J), t[Q] = e;
	}
	function it(t) {
		return nt(t, 34), t;
	}
	function st(t) {
		return nt(t, 8192), t;
	}
	rt(et, 7), tt = Object.freeze(et);
	var ot = {};
	function at(t, e) {
		return void 0 === e ? t.h !== ct && !!(2 & (0 | t.v[Q])) : !!(2 & e) && t.h !== ct;
	}
	var ct = {};
	function ht(t, e) {
		if (null != t) {
			if ("string" == typeof t) t = t ? new F(t, L) : R();
			else if (t.constructor !== F) if (x(t)) t = t.length ? new F(new Uint8Array(t), L) : R();
			else {
				if (!e) throw Error();
				t = void 0;
			}
		}
		return t;
	}
	var ut = class {
		constructor(t, e, n) {
			this.g = t, this.h = e, this.l = n;
		}
		next() {
			const t = this.g.next();
			return t.done || (t.value = this.h.call(this.l, t.value)), t;
		}
		[Symbol.iterator]() {
			return this;
		}
	};
	var lt = Object.freeze({});
	function ft(t, e, n) {
		const r = 128 & e ? 0 : -1, i = t.length;
		var s;
		(s = !!i) && (s = null != (s = t[i - 1]) && "object" == typeof s && s.constructor === Object);
		const o = i + (s ? -1 : 0);
		for (e = 128 & e ? 1 : 0; e < o; e++) n(e - r, t[e]);
		if (s) {
			t = t[i - 1];
			for (const e in t) !isNaN(e) && n(+e, t[e]);
		}
	}
	var dt = {};
	function pt(t) {
		return 128 & t ? dt : void 0;
	}
	function gt(t) {
		return t.Na = !0, t;
	}
	var mt = gt(((t) => "number" == typeof t)), yt = gt(((t) => "string" == typeof t)), _t = gt(((t) => "boolean" == typeof t)), vt = "function" == typeof t.BigInt && "bigint" == typeof t.BigInt(0);
	function Et(t) {
		var e = t;
		if (yt(e)) {
			if (!/^\s*(?:-?[1-9]\d*|0)?\s*$/.test(e)) throw Error(String(e));
		} else if (mt(e) && !Number.isSafeInteger(e)) throw Error(String(e));
		return vt ? BigInt(t) : t = _t(t) ? t ? "1" : "0" : yt(t) ? t.trim() || "0" : String(t);
	}
	var wt = gt(((t) => vt ? t >= At && t <= kt : "-" === t[0] ? St(t, Tt) : St(t, bt)));
	var Tt = Number.MIN_SAFE_INTEGER.toString(), At = vt ? BigInt(Number.MIN_SAFE_INTEGER) : void 0, bt = Number.MAX_SAFE_INTEGER.toString(), kt = vt ? BigInt(Number.MAX_SAFE_INTEGER) : void 0;
	function St(t, e) {
		if (t.length > e.length) return !1;
		if (t.length < e.length || t === e) return !0;
		for (let n = 0; n < t.length; n++) {
			const r = t[n], i = e[n];
			if (r > i) return !1;
			if (r < i) return !0;
		}
	}
	var xt = "function" == typeof Uint8Array.prototype.slice;
	var Lt, Rt = 0, It = 0;
	function Ft(t) {
		const e = t >>> 0;
		Rt = e, It = (t - e) / 4294967296 >>> 0;
	}
	function Mt(t) {
		if (t < 0) {
			Ft(-t);
			const [e, n] = jt(Rt, It);
			Rt = e >>> 0, It = n >>> 0;
		} else Ft(t);
	}
	function Pt(t) {
		const e = Lt || (Lt = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(8)));
		e.setFloat32(0, +t, !0), It = 0, Rt = e.getUint32(0, !0);
	}
	function Ct(t, e) {
		const n = 4294967296 * e + (t >>> 0);
		return Number.isSafeInteger(n) ? n : Ut(t, e);
	}
	function Ot(t, e) {
		return Et(D() ? BigInt.asUintN(64, (BigInt(e >>> 0) << BigInt(32)) + BigInt(t >>> 0)) : Ut(t, e));
	}
	function Nt(t, e) {
		return D() ? Et(BigInt.asIntN(64, (BigInt.asUintN(32, BigInt(e)) << BigInt(32)) + BigInt.asUintN(32, BigInt(t)))) : Et(Bt(t, e));
	}
	function Ut(t, e) {
		if (t >>>= 0, (e >>>= 0) <= 2097151) var n = "" + (4294967296 * e + t);
		else D() ? n = "" + (BigInt(e) << BigInt(32) | BigInt(t)) : (t = (16777215 & t) + 6777216 * (n = 16777215 & (t >>> 24 | e << 8)) + 6710656 * (e = e >> 16 & 65535), n += 8147497 * e, e *= 2, t >= 1e7 && (n += t / 1e7 >>> 0, t %= 1e7), n >= 1e7 && (e += n / 1e7 >>> 0, n %= 1e7), n = e + Dt(n) + Dt(t));
		return n;
	}
	function Dt(t) {
		return t = String(t), "0000000".slice(t.length) + t;
	}
	function Bt(t, e) {
		if (2147483648 & e) if (D()) t = "" + (BigInt(0 | e) << BigInt(32) | BigInt(t >>> 0));
		else {
			const [n, r] = jt(t, e);
			t = "-" + Ut(n, r);
		}
		else t = Ut(t, e);
		return t;
	}
	function Gt(t) {
		if (t.length < 16) Mt(Number(t));
		else if (D()) t = BigInt(t), Rt = Number(t & BigInt(4294967295)) >>> 0, It = Number(t >> BigInt(32) & BigInt(4294967295));
		else {
			const e = +("-" === t[0]);
			It = Rt = 0;
			const n = t.length;
			for (let r = e, i = (n - e) % 6 + e; i <= n; r = i, i += 6) {
				const e = Number(t.slice(r, i));
				It *= 1e6, Rt = 1e6 * Rt + e, Rt >= 4294967296 && (It += Math.trunc(Rt / 4294967296), It >>>= 0, Rt >>>= 0);
			}
			if (e) {
				const [t, e] = jt(Rt, It);
				Rt = t, It = e;
			}
		}
	}
	function jt(t, e) {
		return e = ~e, t ? t = 1 + ~t : e += 1, [t, e];
	}
	function Vt(t) {
		return Array.prototype.slice.call(t);
	}
	var Xt = "function" == typeof BigInt ? BigInt.asIntN : void 0, Ht = "function" == typeof BigInt ? BigInt.asUintN : void 0, Wt = Number.isSafeInteger, zt = Number.isFinite, Kt = Math.trunc, Yt = Et(0);
	function qt(t) {
		if (null != t && "number" != typeof t) throw Error(`Value of float/double field must be a number, found ${typeof t}: ${t}`);
		return t;
	}
	function $t(t) {
		return null == t || "number" == typeof t ? t : "NaN" === t || "Infinity" === t || "-Infinity" === t ? Number(t) : void 0;
	}
	function Jt(t) {
		if (null != t && "boolean" != typeof t) {
			var e = typeof t;
			throw Error(`Expected boolean but got ${"object" != e ? e : t ? Array.isArray(t) ? "array" : e : "null"}: ${t}`);
		}
		return t;
	}
	function Zt(t) {
		return null == t || "boolean" == typeof t ? t : "number" == typeof t ? !!t : void 0;
	}
	var Qt = /^-?([1-9][0-9]*|0)(\.[0-9]+)?$/;
	function te(t) {
		switch (typeof t) {
			case "bigint": return !0;
			case "number": return zt(t);
			case "string": return Qt.test(t);
			default: return !1;
		}
	}
	function ee(t) {
		if (null == t) return t;
		if ("string" == typeof t && t) t = +t;
		else if ("number" != typeof t) return;
		return zt(t) ? 0 | t : void 0;
	}
	function ne(t) {
		if (null == t) return t;
		if ("string" == typeof t && t) t = +t;
		else if ("number" != typeof t) return;
		return zt(t) ? t >>> 0 : void 0;
	}
	function re(t) {
		const e = t.length;
		return ("-" === t[0] ? e < 20 || 20 === e && t <= "-9223372036854775808" : e < 19 || 19 === e && t <= "9223372036854775807") ? t : (Gt(t), Bt(Rt, It));
	}
	function ie(t) {
		if (t = Kt(t), !Wt(t)) {
			Mt(t);
			var e = Rt, n = It;
			(t = 2147483648 & n) && (n = ~n >>> 0, 0 == (e = 1 + ~e >>> 0) && (n = n + 1 >>> 0)), t = "number" == typeof (e = Ct(e, n)) ? t ? -e : e : t ? "-" + e : e;
		}
		return t;
	}
	function se(t) {
		var e = Kt(Number(t));
		return Wt(e) ? String(e) : (-1 !== (e = t.indexOf(".")) && (t = t.substring(0, e)), re(t));
	}
	function oe(t) {
		var e = Kt(Number(t));
		return Wt(e) ? Et(e) : (-1 !== (e = t.indexOf(".")) && (t = t.substring(0, e)), D() ? Et(Xt(64, BigInt(t))) : Et(re(t)));
	}
	function ae(t) {
		return Wt(t) ? t = Et(ie(t)) : (t = Kt(t), Wt(t) ? t = String(t) : (Mt(t), t = Bt(Rt, It)), t = Et(t)), t;
	}
	function ce(t) {
		const e = typeof t;
		return null == t ? t : "bigint" === e ? Et(Xt(64, t)) : te(t) ? "string" === e ? oe(t) : ae(t) : void 0;
	}
	function he(t) {
		if ("string" != typeof t) throw Error();
		return t;
	}
	function ue(t) {
		if (null != t && "string" != typeof t) throw Error();
		return t;
	}
	function le(t) {
		return null == t || "string" == typeof t ? t : void 0;
	}
	function fe(t, e, n, r) {
		return null != t && t[q] === ot ? t : Array.isArray(t) ? ((r = (n = 0 | t[Q]) | 32 & r | 2 & r) !== n && rt(t, r), new e(t)) : (n ? 2 & r ? ((t = e[V]) || (it((t = new e()).v), t = e[V] = t), e = t) : e = new e() : e = void 0, e);
	}
	function de(t, e, n) {
		if (e) t: {
			if (!te(e = t)) throw N("int64");
			switch (typeof e) {
				case "string":
					e = oe(e);
					break t;
				case "bigint":
					e = Et(Xt(64, e));
					break t;
				default: e = ae(e);
			}
		}
		else e = ce(t);
		return null == (t = e) ? n ? Yt : void 0 : t;
	}
	var pe = {};
	var ge = function() {
		try {
			return m(new class extends Map {
				constructor() {
					super();
				}
			}()), !1;
		} catch {
			return !0;
		}
	}();
	var me = class {
		constructor() {
			this.g = /* @__PURE__ */ new Map();
		}
		get(t) {
			return this.g.get(t);
		}
		set(t, e) {
			return this.g.set(t, e), this.size = this.g.size, this;
		}
		delete(t) {
			return t = this.g.delete(t), this.size = this.g.size, t;
		}
		clear() {
			this.g.clear(), this.size = this.g.size;
		}
		has(t) {
			return this.g.has(t);
		}
		entries() {
			return this.g.entries();
		}
		keys() {
			return this.g.keys();
		}
		values() {
			return this.g.values();
		}
		forEach(t, e) {
			return this.g.forEach(t, e);
		}
		[Symbol.iterator]() {
			return this.entries();
		}
	};
	var ye = ge ? (Object.setPrototypeOf(me.prototype, Map.prototype), Object.defineProperties(me.prototype, { size: {
		value: 0,
		configurable: !0,
		enumerable: !0,
		writable: !0
	} }), me) : class extends Map {
		constructor() {
			super();
		}
	};
	function _e(t) {
		return t;
	}
	function ve(t) {
		if (2 & t.J) throw Error("Cannot mutate an immutable Map");
	}
	var Ee = class extends ye {
		constructor(t, e, n = _e, r = _e) {
			super(), this.J = 0 | t[Q], this.K = e, this.S = n, this.fa = this.K ? we : r;
			for (let i = 0; i < t.length; i++) {
				const s = t[i], o = n(s[0], !1, !0);
				let a = s[1];
				e ? void 0 === a && (a = null) : a = r(s[1], !1, !0, void 0, void 0, this.J), super.set(o, a);
			}
		}
		V(t) {
			return st(Array.from(super.entries(), t));
		}
		clear() {
			ve(this), super.clear();
		}
		delete(t) {
			return ve(this), super.delete(this.S(t, !0, !1));
		}
		entries() {
			if (this.K) {
				var t = super.keys();
				t = new ut(t, Te, this);
			} else t = super.entries();
			return t;
		}
		values() {
			if (this.K) {
				var t = super.keys();
				t = new ut(t, Ee.prototype.get, this);
			} else t = super.values();
			return t;
		}
		forEach(t, e) {
			this.K ? super.forEach(((n, r, i) => {
				t.call(e, i.get(r), r, i);
			})) : super.forEach(t, e);
		}
		set(t, e) {
			return ve(this), null == (t = this.S(t, !0, !1)) ? this : null == e ? (super.delete(t), this) : super.set(t, this.fa(e, !0, !0, this.K, !1, this.J));
		}
		Ma(t) {
			const e = this.S(t[0], !1, !0);
			t = t[1], t = this.K ? void 0 === t ? null : t : this.fa(t, !1, !0, void 0, !1, this.J), super.set(e, t);
		}
		has(t) {
			return super.has(this.S(t, !1, !1));
		}
		get(t) {
			t = this.S(t, !1, !1);
			const e = super.get(t);
			if (void 0 !== e) {
				var n = this.K;
				return n ? ((n = this.fa(e, !1, !0, n, this.ra, this.J)) !== e && super.set(t, n), n) : e;
			}
		}
		[Symbol.iterator]() {
			return this.entries();
		}
	};
	function we(t, e, n, r, i, s) {
		return t = fe(t, r, n, s), i && (t = Xe(t)), t;
	}
	function Te(t) {
		return [t, this.get(t)];
	}
	var Ae;
	function be() {
		return Ae || (Ae = new Ee(it([]), void 0, void 0, void 0, pe));
	}
	function ke(t) {
		return H ? t[H] : void 0;
	}
	function Se(t, e) {
		for (const n in t) !isNaN(n) && e(t, +n, t[n]);
	}
	Ee.prototype.toJSON = void 0;
	var xe = class {};
	var Le = { Ka: !0 };
	function Re(t, e) {
		e < 100 || U(z, 1);
	}
	function Ie(t, e, n, r) {
		const i = void 0 !== r;
		r = !!r;
		var s, o = H;
		!i && B && o && (s = t[o]) && Se(s, Re), o = [];
		var a = t.length;
		let c;
		s = 4294967295;
		let h = !1;
		const u = !!(64 & e), l = u ? 128 & e ? 0 : -1 : void 0;
		1 & e || (c = a && t[a - 1], null != c && "object" == typeof c && c.constructor === Object ? s = --a : c = void 0, !u || 128 & e || i || (h = !0, s = s - l + l)), e = void 0;
		for (var f = 0; f < a; f++) {
			let i = t[f];
			if (null != i && null != (i = n(i, r))) if (u && f >= s) {
				const t = f - l;
				(e ?? (e = {}))[t] = i;
			} else o[f] = i;
		}
		if (c) for (let t in c) {
			if (null == (a = c[t]) || null == (a = n(a, r))) continue;
			let i;
			f = +t, u && !Number.isNaN(f) && (i = f + l) < s ? o[i] = a : (e ?? (e = {}))[t] = a;
		}
		return e && (h ? o.push(e) : o[s] = e), i && H && (t = ke(t)) && t instanceof xe && (o[H] = function(t) {
			const e = new xe();
			return Se(t, ((t, n, r) => {
				e[n] = Vt(r);
			})), e.da = t.da, e;
		}(t)), o;
	}
	function Fe(t) {
		return t[0] = Me(t[0]), t[1] = Me(t[1]), t;
	}
	function Me(t) {
		switch (typeof t) {
			case "number": return Number.isFinite(t) ? t : "" + t;
			case "bigint": return wt(t) ? Number(t) : "" + t;
			case "boolean": return t ? 1 : 0;
			case "object":
				if (Array.isArray(t)) {
					var e = 0 | t[Q];
					return 0 === t.length && 1 & e ? void 0 : Ie(t, e, Me);
				}
				if (null != t && t[q] === ot) return Oe(t);
				if (t instanceof F) {
					if (null == (e = t.g)) t = "";
					else if ("string" == typeof e) t = e;
					else {
						if (T) {
							for (var n = "", r = 0, i = e.length - 10240; r < i;) n += String.fromCharCode.apply(null, e.subarray(r, r += 10240));
							n += String.fromCharCode.apply(null, r ? e.subarray(r) : e), e = btoa(n);
						} else {
							void 0 === n && (n = 0), E(), n = y[n], r = Array(Math.floor(e.length / 3)), i = n[64] || "";
							let t = 0, h = 0;
							for (; t < e.length - 2; t += 3) {
								var s = e[t], o = e[t + 1], a = e[t + 2], c = n[s >> 2];
								s = n[(3 & s) << 4 | o >> 4], o = n[(15 & o) << 2 | a >> 6], a = n[63 & a], r[h++] = c + s + o + a;
							}
							switch (c = 0, a = i, e.length - t) {
								case 2: a = n[(15 & (c = e[t + 1])) << 2] || i;
								case 1: e = e[t], r[h] = n[e >> 2] + n[(3 & e) << 4 | c >> 4] + a + i;
							}
							e = r.join("");
						}
						t = t.g = e;
					}
					return t;
				}
				return t instanceof Ee ? t = 0 !== t.size ? t.V(Fe) : void 0 : void 0;
		}
		return t;
	}
	var Pe, Ce;
	function Oe(t) {
		return Ie(t = t.v, 0 | t[Q], Me);
	}
	function Ne(t, e) {
		return Ue(t, e[0], e[1]);
	}
	function Ue(t, e, n, r = 0) {
		if (null == t) {
			var i = 32;
			n ? (t = [n], i |= 128) : t = [], e && (i = -16760833 & i | (1023 & e) << 14);
		} else {
			if (!Array.isArray(t)) throw Error("narr");
			if (i = 0 | t[Q], d && 1 & i) throw Error("rfarr");
			if (2048 & i && !(2 & i) && function() {
				if (d) throw Error("carr");
				U(Y, 5);
			}(), 256 & i) throw Error("farr");
			if (64 & i) return (i | r) !== i && rt(t, i | r), t;
			if (n && (i |= 128, n !== t[0])) throw Error("mid");
			t: {
				i |= 64;
				var s = (n = t).length;
				if (s) {
					var o = s - 1;
					const t = n[o];
					if (null != t && "object" == typeof t && t.constructor === Object) {
						if ((o -= e = 128 & i ? 0 : -1) >= 1024) throw Error("pvtlmt");
						for (var a in t) (s = +a) < o && (n[s + e] = t[a], delete t[a]);
						i = -16760833 & i | (1023 & o) << 14;
						break t;
					}
				}
				if (e) {
					if ((a = Math.max(e, s - (128 & i ? 0 : -1))) > 1024) throw Error("spvt");
					i = -16760833 & i | (1023 & a) << 14;
				}
			}
		}
		return rt(t, 64 | i | r), t;
	}
	function De(t, e) {
		if ("object" != typeof t) return t;
		if (Array.isArray(t)) {
			var n = 0 | t[Q];
			return 0 === t.length && 1 & n ? void 0 : Be(t, n, e);
		}
		if (null != t && t[q] === ot) return je(t);
		if (t instanceof Ee) {
			if (2 & (e = t.J)) return t;
			if (!t.size) return;
			if (n = it(t.V()), t.K) for (t = 0; t < n.length; t++) {
				const r = n[t];
				let i = r[1];
				i = null == i || "object" != typeof i ? void 0 : null != i && i[q] === ot ? je(i) : Array.isArray(i) ? Be(i, 0 | i[Q], !!(32 & e)) : void 0, r[1] = i;
			}
			return n;
		}
		return t instanceof F ? t : void 0;
	}
	function Be(t, e, n) {
		return 2 & e || (!n || 4096 & e || 16 & e ? t = Ve(t, e, !1, n && !(16 & e)) : (nt(t, 34), 4 & e && Object.freeze(t))), t;
	}
	function Ge(t, e, n) {
		return t = new t.constructor(e), n && (t.h = ct), t.m = ct, t;
	}
	function je(t) {
		const e = t.v, n = 0 | e[Q];
		return at(t, n) ? t : Ke(t, e, n) ? Ge(t, e) : Ve(e, n);
	}
	function Ve(t, e, n, r) {
		return r ?? (r = !!(34 & e)), t = Ie(t, e, De, r), r = 32, n && (r |= 2), rt(t, e = 16769217 & e | r), t;
	}
	function Xe(t) {
		const e = t.v, n = 0 | e[Q];
		return at(t, n) ? Ke(t, e, n) ? Ge(t, e, !0) : new t.constructor(Ve(e, n, !1)) : t;
	}
	function He(t) {
		if (t.h !== ct) return !1;
		var e = t.v;
		return nt(e = Ve(e, 0 | e[Q]), 2048), t.v = e, t.h = void 0, t.m = void 0, !0;
	}
	function We(t) {
		if (!He(t) && at(t, 0 | t.v[Q])) throw Error();
	}
	function ze(t, e) {
		void 0 === e && (e = 0 | t[Q]), 32 & e && !(4096 & e) && rt(t, 4096 | e);
	}
	function Ke(t, e, n) {
		return !!(2 & n) || !(!(32 & n) || 4096 & n) && (rt(e, 2 | n), t.h = ct, !0);
	}
	var Ye = Et(0), qe = {};
	function $e(t, e, n, r, i) {
		if (null !== (e = Je(t.v, e, n, i)) || r && t.m !== ct) return e;
	}
	function Je(t, e, n, r) {
		if (-1 === e) return null;
		const i = e + (n ? 0 : -1), s = t.length - 1;
		let o, a;
		if (!(s < 1 + (n ? 0 : -1))) {
			if (i >= s) if (o = t[s], null != o && "object" == typeof o && o.constructor === Object) n = o[e], a = !0;
			else {
				if (i !== s) return;
				n = o;
			}
			else n = t[i];
			if (r && null != n) {
				if (null == (r = r(n))) return r;
				if (!Object.is(r, n)) return a ? o[e] = r : t[i] = r, r;
			}
			return n;
		}
	}
	function Ze(t, e, n, r) {
		We(t), Qe(t = t.v, 0 | t[Q], e, n, r);
	}
	function Qe(t, e, n, r, i) {
		const s = n + (i ? 0 : -1);
		var o = t.length - 1;
		if (o >= 1 + (i ? 0 : -1) && s >= o) {
			const i = t[o];
			if (null != i && "object" == typeof i && i.constructor === Object) return i[n] = r, e;
		}
		return s <= o ? (t[s] = r, e) : (void 0 !== r && (n >= (o = (e ?? (e = 0 | t[Q])) >> 14 & 1023 || 536870912) ? null != r && (t[o + (i ? 0 : -1)] = { [n]: r }) : t[s] = r), e);
	}
	function tn() {
		return void 0 === lt ? 2 : 4;
	}
	function en(t, e, n, r, i) {
		let s = t.v, o = 0 | s[Q];
		r = at(t, o) ? 1 : r, i = !!i || 3 === r, 2 === r && He(t) && (s = t.v, o = 0 | s[Q]);
		let a = (t = rn(s, e)) === tt ? 7 : 0 | t[Q], c = sn(a, o);
		var h = !(4 & c);
		if (h) {
			4 & c && (t = Vt(t), a = 0, c = An(c, o), o = Qe(s, o, e, t));
			let r = 0, i = 0;
			for (; r < t.length; r++) {
				const e = n(t[r]);
				null != e && (t[i++] = e);
			}
			i < r && (t.length = i), n = -513 & (4 | c), c = n &= -1025, c &= -4097;
		}
		return c !== a && (rt(t, c), 2 & c && Object.freeze(t)), nn(t, c, s, o, e, r, h, i);
	}
	function nn(t, e, n, r, i, s, o, a) {
		let c = e;
		return 1 === s || 4 === s && (2 & e || !(16 & e) && 32 & r) ? on$1(e) || ((e |= !t.length || o && !(4096 & e) || 32 & r && !(4096 & e || 16 & e) ? 2 : 256) !== c && rt(t, e), Object.freeze(t)) : (2 === s && on$1(e) && (t = Vt(t), c = 0, e = An(e, r), r = Qe(n, r, i, t)), on$1(e) || (a || (e |= 16), e !== c && rt(t, e))), 2 & e || !(4096 & e || 16 & e) || ze(n, r), t;
	}
	function rn(t, e, n) {
		return t = Je(t, e, n), Array.isArray(t) ? t : tt;
	}
	function sn(t, e) {
		return 2 & e && (t |= 2), 1 | t;
	}
	function on$1(t) {
		return !!(2 & t) && !!(4 & t) || !!(256 & t);
	}
	function an(t) {
		return ht(t, !0);
	}
	function cn(t) {
		t = Vt(t);
		for (let e = 0; e < t.length; e++) {
			const n = t[e] = Vt(t[e]);
			Array.isArray(n[1]) && (n[1] = it(n[1]));
		}
		return st(t);
	}
	function hn(t, e, n, r) {
		We(t), Qe(t = t.v, 0 | t[Q], e, ("0" === r ? 0 === Number(n) : n === r) ? void 0 : n);
	}
	function un(t, e, n) {
		if (2 & e) throw Error();
		const r = pt(e);
		let i = rn(t, n, r), s = i === tt ? 7 : 0 | i[Q], o = sn(s, e);
		return (2 & o || on$1(o) || 16 & o) && (o === s || on$1(o) || rt(i, o), i = Vt(i), s = 0, o = An(o, e), Qe(t, e, n, i, r)), o &= -13, o !== s && rt(i, o), i;
	}
	function ln(t, e) {
		var n = Cs;
		return pn(fn(t = t.v), t, void 0, n) === e ? e : -1;
	}
	function fn(t) {
		if (B) return t[X] ?? (t[X] = /* @__PURE__ */ new Map());
		if (X in t) return t[X];
		const e = /* @__PURE__ */ new Map();
		return Object.defineProperty(t, X, { value: e }), e;
	}
	function dn(t, e, n, r, i) {
		const s = fn(t), o = pn(s, t, e, n, i);
		return o !== r && (o && (e = Qe(t, e, o, void 0, i)), s.set(n, r)), e;
	}
	function pn(t, e, n, r, i) {
		let s = t.get(r);
		if (null != s) return s;
		s = 0;
		for (let t = 0; t < r.length; t++) {
			const o = r[t];
			null != Je(e, o, i) && (0 !== s && (n = Qe(e, n, s, void 0, i)), s = o);
		}
		return t.set(r, s), s;
	}
	function gn(t, e, n) {
		let r = 0 | t[Q];
		const i = pt(r), s = Je(t, n, i);
		let o;
		if (null != s && s[q] === ot) {
			if (!at(s)) return He(s), s.v;
			o = s.v;
		} else Array.isArray(s) && (o = s);
		if (o) {
			const t = 0 | o[Q];
			2 & t && (o = Ve(o, t));
		}
		return o = Ne(o, e), o !== s && Qe(t, r, n, o, i), o;
	}
	function mn(t, e, n, r, i) {
		let s = !1;
		if (null != (r = Je(t, r, i, ((t) => {
			const r = fe(t, n, !1, e);
			return s = r !== t && null != r, r;
		})))) return s && !at(r) && ze(t, e), r;
	}
	function yn(t, e, n, r) {
		let i = t.v, s = 0 | i[Q];
		if (null == (e = mn(i, s, e, n, r))) return e;
		if (s = 0 | i[Q], !at(t, s)) {
			const o = Xe(e);
			o !== e && (He(t) && (i = t.v, s = 0 | i[Q]), s = Qe(i, s, n, e = o, r), ze(i, s));
		}
		return e;
	}
	function _n(t, e, n, r, i, s, o, a) {
		var c = at(t, n);
		s = c ? 1 : s, o = !!o || 3 === s, c = a && !c, (2 === s || c) && He(t) && (n = 0 | (e = t.v)[Q]);
		var h = (t = rn(e, i)) === tt ? 7 : 0 | t[Q], u = sn(h, n);
		if (a = !(4 & u)) {
			var l = t, f = n;
			const e = !!(2 & u);
			e && (f |= 2);
			let i = !e, s = !0, o = 0, a = 0;
			for (; o < l.length; o++) {
				const t = fe(l[o], r, !1, f);
				if (t instanceof r) {
					if (!e) {
						const e = at(t);
						i && (i = !e), s && (s = e);
					}
					l[a++] = t;
				}
			}
			a < o && (l.length = a), u |= 4, u = s ? -4097 & u : 4096 | u, u = i ? 8 | u : -9 & u;
		}
		if (u !== h && (rt(t, u), 2 & u && Object.freeze(t)), c && !(8 & u || !t.length && (1 === s || 4 === s && (2 & u || !(16 & u) && 32 & n)))) {
			for (on$1(u) && (t = Vt(t), u = An(u, n), n = Qe(e, n, i, t)), r = t, c = u, h = 0; h < r.length; h++) (l = r[h]) !== (u = Xe(l)) && (r[h] = u);
			c |= 8, rt(t, u = c = r.length ? 4096 | c : -4097 & c);
		}
		return nn(t, u, e, n, i, s, a, o);
	}
	function vn(t, e, n) {
		const r = t.v;
		return _n(t, r, 0 | r[Q], e, n, tn(), !1, !0);
	}
	function En(t) {
		return t ?? (t = void 0), t;
	}
	function wn(t, e, n, r, i) {
		return Ze(t, n, r = En(r), i), r && !at(r) && ze(t.v), t;
	}
	function Tn(t, e, n, r) {
		t: {
			var i = r = En(r);
			We(t);
			const s = t.v;
			let o = 0 | s[Q];
			if (null == i) {
				const t = fn(s);
				if (pn(t, s, o, n) !== e) break t;
				t.set(n, 0);
			} else o = dn(s, o, n, e);
			Qe(s, o, e, i);
		}
		r && !at(r) && ze(t.v);
	}
	function An(t, e) {
		return -273 & (2 & e ? 2 | t : -3 & t);
	}
	function bn(t, e, n, r) {
		var i = r;
		We(t), t = _n(t, r = t.v, 0 | r[Q], n, e, 2, !0), i = null != i ? i : new n(), t.push(i), e = n = t === tt ? 7 : 0 | t[Q], (i = at(i)) ? (n &= -9, 1 === t.length && (n &= -4097)) : n |= 4096, n !== e && rt(t, n), i || ze(r);
	}
	function kn(t, e, n) {
		return ee($e(t, e, void 0, n));
	}
	function Sn(t, e) {
		return $e(t, e, void 0, void 0, $t) ?? 0;
	}
	function xn(t, e, n) {
		if (null != n) {
			if ("number" != typeof n) throw N("int32");
			if (!zt(n)) throw N("int32");
			n |= 0;
		}
		Ze(t, e, n);
	}
	function Ln(t, e, n) {
		Ze(t, e, qt(n));
	}
	function Rn(t, e, n) {
		hn(t, e, ue(n), "");
	}
	function In(t, e, n) {
		{
			We(t);
			const o = t.v;
			let a = 0 | o[Q];
			if (null == n) Qe(o, a, e);
			else {
				var r = t = n === tt ? 7 : 0 | n[Q], i = on$1(t), s = i || Object.isFrozen(n);
				for (i || (t = 0), s || (n = Vt(n), r = 0, t = An(t, a), s = !1), t |= 5, t |= (4 & t ? 512 & t ? 512 : 1024 & t ? 1024 : 0 : void 0) ?? 1024, i = 0; i < n.length; i++) {
					const e = n[i], o = he(e);
					Object.is(e, o) || (s && (n = Vt(n), r = 0, t = An(t, a), s = !1), n[i] = o);
				}
				t !== r && (s && (n = Vt(n), t = An(t, a)), rt(n, t)), Qe(o, a, e, n);
			}
		}
	}
	function Fn(t, e, n) {
		We(t), en(t, e, le, 2, !0).push(he(n));
	}
	var Mn = class {
		constructor(t, e, n) {
			if (this.buffer = t, n && !e) throw Error();
			this.g = e;
		}
	};
	function Pn(t, e) {
		if ("string" == typeof t) return new Mn(S$1(t), e);
		if (Array.isArray(t)) return new Mn(new Uint8Array(t), e);
		if (t.constructor === Uint8Array) return new Mn(t, !1);
		if (t.constructor === ArrayBuffer) return t = new Uint8Array(t), new Mn(t, !1);
		if (t.constructor === F) return e = I(t) || new Uint8Array(0), new Mn(e, !0, t);
		if (t instanceof Uint8Array) return t = t.constructor === Uint8Array ? t : new Uint8Array(t.buffer, t.byteOffset, t.byteLength), new Mn(t, !1);
		throw Error();
	}
	function Cn(t, e) {
		let n, r = 0, i = 0, s = 0;
		const o = t.h;
		let a = t.g;
		do
			n = o[a++], r |= (127 & n) << s, s += 7;
		while (s < 32 && 128 & n);
		if (s > 32) for (i |= (127 & n) >> 4, s = 3; s < 32 && 128 & n; s += 7) n = o[a++], i |= (127 & n) << s;
		if (Gn(t, a), !(128 & n)) return e(r >>> 0, i >>> 0);
		throw Error();
	}
	function On(t) {
		let e = 0, n = t.g;
		const r = n + 10, i = t.h;
		for (; n < r;) {
			const r = i[n++];
			if (e |= r, 0 == (128 & r)) return Gn(t, n), !!(127 & e);
		}
		throw Error();
	}
	function Nn(t) {
		const e = t.h;
		let n = t.g, r = e[n++], i = 127 & r;
		if (128 & r && (r = e[n++], i |= (127 & r) << 7, 128 & r && (r = e[n++], i |= (127 & r) << 14, 128 & r && (r = e[n++], i |= (127 & r) << 21, 128 & r && (r = e[n++], i |= r << 28, 128 & r && 128 & e[n++] && 128 & e[n++] && 128 & e[n++] && 128 & e[n++] && 128 & e[n++]))))) throw Error();
		return Gn(t, n), i;
	}
	function Un(t) {
		return Nn(t) >>> 0;
	}
	function Dn(t) {
		var e = t.h;
		const n = t.g;
		var r = e[n], i = e[n + 1];
		const s = e[n + 2];
		return e = e[n + 3], Gn(t, t.g + 4), t = 2 * ((i = (r << 0 | i << 8 | s << 16 | e << 24) >>> 0) >> 31) + 1, r = i >>> 23 & 255, i &= 8388607, 255 == r ? i ? NaN : t * Infinity : 0 == r ? 1401298464324817e-60 * t * i : t * Math.pow(2, r - 150) * (i + 8388608);
	}
	function Bn(t) {
		return Nn(t);
	}
	function Gn(t, e) {
		if (t.g = e, e > t.l) throw Error();
	}
	function jn(t, e) {
		if (e < 0) throw Error();
		const n = t.g;
		if ((e = n + e) > t.l) throw Error();
		return t.g = e, n;
	}
	function Vn(t, e) {
		if (0 == e) return R();
		var n = jn(t, e);
		return t.Y && t.j ? n = t.h.subarray(n, n + e) : (t = t.h, n = n === (e = n + e) ? new Uint8Array(0) : xt ? t.slice(n, e) : new Uint8Array(t.subarray(n, e))), 0 == n.length ? R() : new F(n, L);
	}
	var Xn = [];
	function Hn(t, e, n, r) {
		if (Qn.length) {
			const i = Qn.pop();
			return i.o(r), i.g.init(t, e, n, r), i;
		}
		return new Zn(t, e, n, r);
	}
	function Wn(t) {
		t.g.clear(), t.l = -1, t.h = -1, Qn.length < 100 && Qn.push(t);
	}
	function zn(t) {
		var e = t.g;
		if (e.g == e.l) return !1;
		t.m = t.g.g;
		var n = Un(t.g);
		if (e = n >>> 3, !((n &= 7) >= 0 && n <= 5)) throw Error();
		if (e < 1) throw Error();
		return t.l = e, t.h = n, !0;
	}
	function Kn(t) {
		switch (t.h) {
			case 0:
				0 != t.h ? Kn(t) : On(t.g);
				break;
			case 1:
				Gn(t = t.g, t.g + 8);
				break;
			case 2:
				if (2 != t.h) Kn(t);
				else {
					var e = Un(t.g);
					Gn(t = t.g, t.g + e);
				}
				break;
			case 5:
				Gn(t = t.g, t.g + 4);
				break;
			case 3:
				for (e = t.l;;) {
					if (!zn(t)) throw Error();
					if (4 == t.h) {
						if (t.l != e) throw Error();
						break;
					}
					Kn(t);
				}
				break;
			default: throw Error();
		}
	}
	function Yn(t, e, n) {
		const r = t.g.l;
		var i = Un(t.g);
		let s = (i = t.g.g + i) - r;
		if (s <= 0 && (t.g.l = i, n(e, t, void 0, void 0, void 0), s = i - t.g.g), s) throw Error();
		return t.g.g = i, t.g.l = r, e;
	}
	function qn(t) {
		var e = Un(t.g), a = jn(t = t.g, e);
		if (t = t.h, o) {
			var c, h = t;
			(c = s) || (c = s = new TextDecoder("utf-8", { fatal: !0 })), e = a + e, h = 0 === a && e === h.length ? h : h.subarray(a, e);
			try {
				var u = c.decode(h);
			} catch (t) {
				if (void 0 === i) {
					try {
						c.decode(new Uint8Array([128]));
					} catch (t) {}
					try {
						c.decode(new Uint8Array([97])), i = !0;
					} catch (t) {
						i = !1;
					}
				}
				throw !i && (s = void 0), t;
			}
		} else {
			e = (u = a) + e, a = [];
			let i, s = null;
			for (; u < e;) {
				var l = t[u++];
				l < 128 ? a.push(l) : l < 224 ? u >= e ? n() : (i = t[u++], l < 194 || 128 != (192 & i) ? (u--, n()) : a.push((31 & l) << 6 | 63 & i)) : l < 240 ? u >= e - 1 ? n() : (i = t[u++], 128 != (192 & i) || 224 === l && i < 160 || 237 === l && i >= 160 || 128 != (192 & (c = t[u++])) ? (u--, n()) : a.push((15 & l) << 12 | (63 & i) << 6 | 63 & c)) : l <= 244 ? u >= e - 2 ? n() : (i = t[u++], 128 != (192 & i) || i - 144 + (l << 28) >> 30 != 0 || 128 != (192 & (c = t[u++])) || 128 != (192 & (h = t[u++])) ? (u--, n()) : (l = (7 & l) << 18 | (63 & i) << 12 | (63 & c) << 6 | 63 & h, l -= 65536, a.push(55296 + (l >> 10 & 1023), 56320 + (1023 & l)))) : n(), a.length >= 8192 && (s = r(s, a), a.length = 0);
			}
			u = r(s, a);
		}
		return u;
	}
	function $n(t) {
		const e = Un(t.g);
		return Vn(t.g, e);
	}
	function Jn(t, e, n) {
		var r = Un(t.g);
		for (r = t.g.g + r; t.g.g < r;) n.push(e(t.g));
	}
	var Zn = class {
		constructor(t, e, n, r) {
			if (Xn.length) {
				const i = Xn.pop();
				i.init(t, e, n, r), t = i;
			} else t = new class {
				constructor(t, e, n, r) {
					this.h = null, this.j = !1, this.g = this.l = this.m = 0, this.init(t, e, n, r);
				}
				init(t, e, n, { Y: r = !1, ea: i = !1 } = {}) {
					this.Y = r, this.ea = i, t && (t = Pn(t, this.ea), this.h = t.buffer, this.j = t.g, this.m = e || 0, this.l = void 0 !== n ? this.m + n : this.h.length, this.g = this.m);
				}
				clear() {
					this.h = null, this.j = !1, this.g = this.l = this.m = 0, this.Y = !1;
				}
			}(t, e, n, r);
			this.g = t, this.m = this.g.g, this.h = this.l = -1, this.o(r);
		}
		o({ ha: t = !1 } = {}) {
			this.ha = t;
		}
	}, Qn = [];
	function tr(t) {
		return t ? /^\d+$/.test(t) ? (Gt(t), new er(Rt, It)) : null : nr || (nr = new er(0, 0));
	}
	var er = class {
		constructor(t, e) {
			this.h = t >>> 0, this.g = e >>> 0;
		}
	};
	var nr;
	function rr(t) {
		return t ? /^-?\d+$/.test(t) ? (Gt(t), new ir(Rt, It)) : null : sr || (sr = new ir(0, 0));
	}
	var ir = class {
		constructor(t, e) {
			this.h = t >>> 0, this.g = e >>> 0;
		}
	};
	var sr;
	function or(t, e, n) {
		for (; n > 0 || e > 127;) t.g.push(127 & e | 128), e = (e >>> 7 | n << 25) >>> 0, n >>>= 7;
		t.g.push(e);
	}
	function ar(t, e) {
		for (; e > 127;) t.g.push(127 & e | 128), e >>>= 7;
		t.g.push(e);
	}
	function cr(t, e) {
		if (e >= 0) ar(t, e);
		else {
			for (let n = 0; n < 9; n++) t.g.push(127 & e | 128), e >>= 7;
			t.g.push(1);
		}
	}
	function hr(t) {
		var e = Rt;
		t.g.push(e >>> 0 & 255), t.g.push(e >>> 8 & 255), t.g.push(e >>> 16 & 255), t.g.push(e >>> 24 & 255);
	}
	function ur(t, e) {
		0 !== e.length && (t.l.push(e), t.h += e.length);
	}
	function lr(t, e, n) {
		ar(t.g, 8 * e + n);
	}
	function fr(t, e) {
		return lr(t, e, 2), e = t.g.end(), ur(t, e), e.push(t.h), e;
	}
	function dr(t, e) {
		var n = e.pop();
		for (n = t.h + t.g.length() - n; n > 127;) e.push(127 & n | 128), n >>>= 7, t.h++;
		e.push(n), t.h++;
	}
	function pr(t, e, n) {
		lr(t, e, 2), ar(t.g, n.length), ur(t, t.g.end()), ur(t, n);
	}
	function gr(t, e, n, r) {
		null != n && (e = fr(t, e), r(n, t), dr(t, e));
	}
	function mr() {
		const t = class {
			constructor() {
				throw Error();
			}
		};
		return Object.setPrototypeOf(t, t.prototype), t;
	}
	var yr = mr(), _r = mr(), vr = mr(), Er = mr(), wr = mr(), Tr = mr(), Ar = mr(), br = mr(), kr = mr(), Sr = mr();
	function xr(t, e, n) {
		var r = t.v;
		H && H in r && (r = r[H]) && delete r[e.g], e.h ? e.j(t, e.h, e.g, n, e.l) : e.j(t, e.g, n, e.l);
	}
	var Lr = class {
		constructor(t, e) {
			this.v = Ue(t, e, void 0, 2048);
		}
		toJSON() {
			return Oe(this);
		}
		j() {
			var t = xo, e = this.v, n = t.g, r = H;
			if (B && r && null != e[r]?.[n] && U(W, 3), e = t.g, $$1 && H && void 0 === $$1 && (r = (n = this.v)[H]) && (r = r.da)) try {
				r(n, e, Le);
			} catch (t) {
				u(t);
			}
			return t.h ? t.m(this, t.h, t.g, t.l) : t.m(this, t.g, t.defaultValue, t.l);
		}
		clone() {
			const t = this.v, e = 0 | t[Q];
			return Ke(this, t, e) ? Ge(this, t, !0) : new this.constructor(Ve(t, e, !1));
		}
	};
	Lr.prototype[q] = ot, Lr.prototype.toString = function() {
		return this.v.toString();
	};
	var Rr = class {
		constructor(t, e, n) {
			this.g = t, this.h = e, t = yr, this.l = !!t && n === t || !1;
		}
	};
	function Ir(t, e) {
		return new Rr(t, e, yr);
	}
	function Fr(t, e, n, r, i) {
		gr(t, n, Xr(e, r), i);
	}
	var Mr = Ir((function(t, e, n, r, i) {
		return 2 === t.h && (Yn(t, gn(e, r, n), i), !0);
	}), Fr), Pr = Ir((function(t, e, n, r, i) {
		return 2 === t.h && (Yn(t, gn(e, r, n), i), !0);
	}), Fr);
	var Cr = Symbol(), Or = Symbol(), Nr = Symbol(), Ur = Symbol(), Dr = Symbol();
	var Br, Gr;
	function jr(t, e, n, r) {
		var i = r[t];
		if (i) return i;
		(i = {}).qa = r, i.T = function(t) {
			switch (typeof t) {
				case "boolean": return Pe || (Pe = [
					0,
					void 0,
					!0
				]);
				case "number": return t > 0 ? void 0 : 0 === t ? Ce || (Ce = [0, void 0]) : [-t, void 0];
				case "string": return [0, t];
				case "object": return t;
			}
		}(r[0]);
		var s = r[1];
		let o = 1;
		s && s.constructor === Object && (i.ba = s, "function" == typeof (s = r[++o]) && (i.ma = !0, Br ?? (Br = s), Gr ?? (Gr = r[o + 1]), s = r[o += 2]));
		const a = {};
		for (; s && Array.isArray(s) && s.length && "number" == typeof s[0] && s[0] > 0;) {
			for (var c = 0; c < s.length; c++) a[s[c]] = s;
			s = r[++o];
		}
		for (c = 1; void 0 !== s;) {
			let t;
			"number" == typeof s && (c += s, s = r[++o]);
			var h = void 0;
			if (s instanceof Rr ? t = s : (t = Mr, o--), t?.l) {
				s = r[++o], h = r;
				var u = o;
				"function" == typeof s && (s = s(), h[u] = s), h = s;
			}
			for (u = c + 1, "number" == typeof (s = r[++o]) && s < 0 && (u -= s, s = r[++o]); c < u; c++) {
				const r = a[c];
				h ? n(i, c, t, h, r) : e(i, c, t, r);
			}
		}
		return r[t] = i;
	}
	function Vr(t) {
		return Array.isArray(t) ? t[0] instanceof Rr ? t : [Pr, t] : [t, void 0];
	}
	function Xr(t, e) {
		return t instanceof Lr ? t.v : Array.isArray(t) ? Ne(t, e) : void 0;
	}
	function Hr(t, e, n, r) {
		const i = n.g;
		t[e] = r ? (t, e, n) => i(t, e, n, r) : i;
	}
	function Wr(t, e, n, r, i) {
		const s = n.g;
		let o, a;
		t[e] = (t, e, n) => s(t, e, n, a || (a = jr(Or, Hr, Wr, r).T), o || (o = zr(r)), i);
	}
	function zr(t) {
		let e = t[Nr];
		if (null != e) return e;
		const n = jr(Or, Hr, Wr, t);
		return e = n.ma ? (t, e) => Br(t, e, n) : (t, e) => {
			for (; zn(e) && 4 != e.h;) {
				var r = e.l, i = n[r];
				if (null == i) {
					var s = n.ba;
					s && (s = s[r]) && null != (s = Yr(s)) && (i = n[r] = s);
				}
				if (null == i || !i(e, t, r)) {
					if (i = (s = e).m, Kn(s), s.ha) var o = void 0;
					else o = s.g.g - i, s.g.g = i, o = Vn(s.g, o);
					i = void 0, s = t, o && ((i = s[H] ?? (s[H] = new xe()))[r] ?? (i[r] = [])).push(o);
				}
			}
			return (t = ke(t)) && (t.da = n.qa[Dr]), !0;
		}, t[Nr] = e, t[Dr] = Kr.bind(t), e;
	}
	function Kr(t, e, n, r) {
		var i = this[Or];
		const s = this[Nr], o = Ne(void 0, i.T), a = ke(t);
		if (a) {
			var c = !1, h = i.ba;
			if (h) {
				if (i = (e, n, i) => {
					if (0 !== i.length) if (h[n]) for (const t of i) {
						e = Hn(t);
						try {
							c = !0, s(o, e);
						} finally {
							Wn(e);
						}
					}
					else r?.(t, n, i);
				}, null == e) Se(a, i);
				else if (null != a) {
					const t = a[e];
					t && i(a, e, t);
				}
				if (c) {
					let r = 0 | t[Q];
					if (2 & r && 2048 & r && !n?.Ka) throw Error();
					const i = pt(r), s = (e, s) => {
						if (null != Je(t, e, i)) {
							if (1 === n?.Qa) return;
							throw Error();
						}
						null != s && (r = Qe(t, r, e, s, i)), delete a[e];
					};
					null == e ? ft(o, 0 | o[Q], ((t, e) => {
						s(t, e);
					})) : s(e, Je(o, e, i));
				}
			}
		}
	}
	function Yr(t) {
		const e = (t = Vr(t))[0].g;
		if (t = t[1]) {
			const n = zr(t), r = jr(Or, Hr, Wr, t).T;
			return (t, i, s) => e(t, i, s, r, n);
		}
		return e;
	}
	function qr(t, e, n) {
		t[e] = n.h;
	}
	function $r(t, e, n, r) {
		let i, s;
		const o = n.h;
		t[e] = (t, e, n) => o(t, e, n, s || (s = jr(Cr, qr, $r, r).T), i || (i = Jr(r)));
	}
	function Jr(t) {
		let e = t[Ur];
		if (!e) {
			const n = jr(Cr, qr, $r, t);
			e = (t, e) => Zr(t, e, n), t[Ur] = e;
		}
		return e;
	}
	function Zr(t, e, n) {
		ft(t, 0 | t[Q], ((t, r) => {
			if (null != r) {
				var i = function(t, e) {
					var n = t[e];
					if (n) return n;
					if ((n = t.ba) && (n = n[e])) {
						var r = (n = Vr(n))[0].h;
						if (n = n[1]) {
							const e = Jr(n), i = jr(Cr, qr, $r, n).T;
							n = t.ma ? Gr(i, e) : (t, n, s) => r(t, n, s, i, e);
						} else n = r;
						return t[e] = n;
					}
				}(n, t);
				i ? i(e, r, t) : t < 500 || U(K, 3);
			}
		})), (t = ke(t)) && Se(t, ((t, n, r) => {
			for (ur(e, e.g.end()), t = 0; t < r.length; t++) ur(e, I(r[t]) || new Uint8Array(0));
		}));
	}
	var Qr = Et(0);
	function ti(t, e) {
		if (Array.isArray(e)) {
			var n = 0 | e[Q];
			if (4 & n) return e;
			for (var r = 0, i = 0; r < e.length; r++) {
				const n = t(e[r]);
				null != n && (e[i++] = n);
			}
			return i < r && (e.length = i), (t = -1537 & (5 | n)) !== n && rt(e, t), 2 & t && Object.freeze(e), e;
		}
	}
	function ei(t, e, n) {
		return new Rr(t, e, n);
	}
	function ni(t, e, n) {
		return new Rr(t, e, n);
	}
	function ri(t, e, n) {
		Qe(t, 0 | t[Q], e, n, pt(0 | t[Q]));
	}
	var ii = Ir((function(t, e, n, r, i) {
		if (2 !== t.h) return !1;
		if (t = Vt(t = Yn(t, Ne([void 0, void 0], r), i)), i = pt(r = 0 | e[Q]), 2 & r) throw Error();
		let s = Je(e, n, i);
		if (s instanceof Ee) 0 != (2 & s.J) ? (s = s.V(), s.push(t), Qe(e, r, n, s, i)) : s.Ma(t);
		else if (Array.isArray(s)) {
			var o = 0 | s[Q];
			8192 & o || rt(s, o |= 8192), 2 & o && (s = cn(s), Qe(e, r, n, s, i)), s.push(t);
		} else Qe(e, r, n, st([t]), i);
		return !0;
	}), (function(t, e, n, r, i) {
		if (e instanceof Ee) e.forEach(((e, s) => {
			gr(t, n, Ne([s, e], r), i);
		}));
		else if (Array.isArray(e)) {
			for (let s = 0; s < e.length; s++) {
				const o = e[s];
				Array.isArray(o) && gr(t, n, Ne(o, r), i);
			}
			st(e);
		}
	}));
	function si(t, e, n) {
		null != (e = $t(e)) && (lr(t, n, 5), t = t.g, Pt(e), hr(t));
	}
	function oi(t, e, n) {
		if (e = function(t) {
			if (null == t) return t;
			const e = typeof t;
			if ("bigint" === e) return String(Xt(64, t));
			if (te(t)) {
				if ("string" === e) return se(t);
				if ("number" === e) return ie(t);
			}
		}(e), null != e) {
			if ("string" == typeof e) rr(e);
			if (null != e) switch (lr(t, n, 0), typeof e) {
				case "number":
					t = t.g, Mt(e), or(t, Rt, It);
					break;
				case "bigint":
					n = BigInt.asUintN(64, e), n = new ir(Number(n & BigInt(4294967295)), Number(n >> BigInt(32))), or(t.g, n.h, n.g);
					break;
				default: n = rr(e), or(t.g, n.h, n.g);
			}
		}
	}
	function ai(t, e, n) {
		null != (e = ee(e)) && null != e && (lr(t, n, 0), cr(t.g, e));
	}
	function ci(t, e, n) {
		null != (e = Zt(e)) && (lr(t, n, 0), t.g.g.push(e ? 1 : 0));
	}
	function hi(t, e, n) {
		null != (e = le(e)) && pr(t, n, h(e));
	}
	function ui(t, e, n, r, i) {
		gr(t, n, Xr(e, r), i);
	}
	function li(t, e, n) {
		null != (e = null == e || "string" == typeof e || e instanceof F ? e : void 0) && pr(t, n, Pn(e, !0).buffer);
	}
	function fi(t, e, n) {
		null != (e = ne(e)) && null != e && (lr(t, n, 0), ar(t.g, e));
	}
	function di(t, e, n) {
		return (5 === t.h || 2 === t.h) && (e = un(e, 0 | e[Q], n), 2 == t.h ? Jn(t, Dn, e) : e.push(Dn(t.g)), !0);
	}
	var pi = ei((function(t, e, n) {
		return 5 === t.h && (ri(e, n, Dn(t.g)), !0);
	}), si, br), gi = ni(di, (function(t, e, n) {
		if (null != (e = ti($t, e))) for (let o = 0; o < e.length; o++) {
			var r = t, i = n, s = e[o];
			null != s && (lr(r, i, 5), r = r.g, Pt(s), hr(r));
		}
	}), br), mi = ni(di, (function(t, e, n) {
		if (null != (e = ti($t, e)) && e.length) {
			lr(t, n, 2), ar(t.g, 4 * e.length);
			for (let r = 0; r < e.length; r++) n = t.g, Pt(e[r]), hr(n);
		}
	}), br), yi = ei((function(t, e, n) {
		return 5 === t.h && (ri(e, n, 0 === (t = Dn(t.g)) ? void 0 : t), !0);
	}), si, br), _i = ei((function(t, e, n) {
		return 0 !== t.h ? t = !1 : (ri(e, n, Cn(t.g, Nt)), t = !0), t;
	}), oi, Tr), vi = ei((function(t, e, n) {
		return 0 !== t.h ? e = !1 : (ri(e, n, (t = Cn(t.g, Nt)) === Qr ? void 0 : t), e = !0), e;
	}), oi, Tr), Ei = ei((function(t, e, n) {
		return 0 !== t.h ? t = !1 : (ri(e, n, Cn(t.g, Ot)), t = !0), t;
	}), (function(t, e, n) {
		if (e = function(t) {
			if (null == t) return t;
			var e = typeof t;
			if ("bigint" === e) return String(Ht(64, t));
			if (te(t)) {
				if ("string" === e) return e = Kt(Number(t)), Wt(e) && e >= 0 ? t = String(e) : (-1 !== (e = t.indexOf(".")) && (t = t.substring(0, e)), (e = "-" !== t[0] && ((e = t.length) < 20 || 20 === e && t <= "18446744073709551615")) || (Gt(t), t = Ut(Rt, It))), t;
				if ("number" === e) return (t = Kt(t)) >= 0 && Wt(t) || (Mt(t), t = Ct(Rt, It)), t;
			}
		}(e), null != e) {
			if ("string" == typeof e) tr(e);
			if (null != e) switch (lr(t, n, 0), typeof e) {
				case "number":
					t = t.g, Mt(e), or(t, Rt, It);
					break;
				case "bigint":
					n = BigInt.asUintN(64, e), n = new er(Number(n & BigInt(4294967295)), Number(n >> BigInt(32))), or(t.g, n.h, n.g);
					break;
				default: n = tr(e), or(t.g, n.h, n.g);
			}
		}
	}), Ar), wi = ei((function(t, e, n) {
		return 0 === t.h && (ri(e, n, Nn(t.g)), !0);
	}), ai, Er), Ti = ni((function(t, e, n) {
		return (0 === t.h || 2 === t.h) && (e = un(e, 0 | e[Q], n), 2 == t.h ? Jn(t, Nn, e) : e.push(Nn(t.g)), !0);
	}), (function(t, e, n) {
		if (null != (e = ti(ee, e)) && e.length) {
			n = fr(t, n);
			for (let n = 0; n < e.length; n++) cr(t.g, e[n]);
			dr(t, n);
		}
	}), Er), Ai = ei((function(t, e, n) {
		return 0 === t.h && (ri(e, n, 0 === (t = Nn(t.g)) ? void 0 : t), !0);
	}), ai, Er), bi = ei((function(t, e, n) {
		return 0 === t.h && (ri(e, n, On(t.g)), !0);
	}), ci, _r), ki = ei((function(t, e, n) {
		return 0 === t.h && (ri(e, n, !1 === (t = On(t.g)) ? void 0 : t), !0);
	}), ci, _r), Si = ni((function(t, e, n) {
		return 2 === t.h && (t = qn(t), un(e, 0 | e[Q], n).push(t), !0);
	}), (function(t, e, n) {
		if (null != (e = ti(le, e))) for (let o = 0; o < e.length; o++) {
			var r = t, i = n, s = e[o];
			null != s && pr(r, i, h(s));
		}
	}), vr), xi = ei((function(t, e, n) {
		return 2 === t.h && (ri(e, n, "" === (t = qn(t)) ? void 0 : t), !0);
	}), hi, vr), Li = ei((function(t, e, n) {
		return 2 === t.h && (ri(e, n, qn(t)), !0);
	}), hi, vr), Ri = function(t, e, n = yr) {
		return new Rr(t, e, n);
	}((function(t, e, n, r, i) {
		return 2 === t.h && (r = Ne(void 0, r), un(e, 0 | e[Q], n).push(r), Yn(t, r, i), !0);
	}), (function(t, e, n, r, i) {
		if (Array.isArray(e)) {
			for (let s = 0; s < e.length; s++) ui(t, e[s], n, r, i);
			1 & (t = 0 | e[Q]) || rt(e, 1 | t);
		}
	})), Ii = Ir((function(t, e, n, r, i, s) {
		if (2 !== t.h) return !1;
		let o = 0 | e[Q];
		return dn(e, o, s, n, pt(o)), Yn(t, e = gn(e, r, n), i), !0;
	}), ui), Fi = ei((function(t, e, n) {
		return 2 === t.h && (ri(e, n, $n(t)), !0);
	}), li, kr), Mi = ni((function(t, e, n) {
		return (0 === t.h || 2 === t.h) && (e = un(e, 0 | e[Q], n), 2 == t.h ? Jn(t, Un, e) : e.push(Un(t.g)), !0);
	}), (function(t, e, n) {
		if (null != (e = ti(ne, e))) for (let o = 0; o < e.length; o++) {
			var r = t, i = n, s = e[o];
			null != s && (lr(r, i, 0), ar(r.g, s));
		}
	}), wr), Pi = ei((function(t, e, n) {
		return 0 === t.h && (ri(e, n, 0 === (t = Un(t.g)) ? void 0 : t), !0);
	}), fi, wr), Ci = ei((function(t, e, n) {
		return 0 === t.h && (ri(e, n, Nn(t.g)), !0);
	}), (function(t, e, n) {
		null != (e = ee(e)) && (e = parseInt(e, 10), lr(t, n, 0), cr(t.g, e));
	}), Sr);
	var Oi = class {
		constructor(t, e) {
			var n = Qi;
			this.g = t, this.h = e, this.m = yn, this.j = wn, this.defaultValue = void 0, this.l = null != n.Oa ? dt : void 0;
		}
		register() {
			m(this);
		}
	};
	function Ni(t, e) {
		return new Oi(t, e);
	}
	function Ui(t, e) {
		return (n, r) => {
			{
				const s = { ea: !0 };
				r && Object.assign(s, r), n = Hn(n, void 0, void 0, s);
				try {
					const r = new t(), s = r.v;
					zr(e)(s, n);
					var i = r;
				} finally {
					Wn(n);
				}
			}
			return i;
		};
	}
	function Di(t) {
		return function() {
			const e = new class {
				constructor() {
					this.l = [], this.h = 0, this.g = new class {
						constructor() {
							this.g = [];
						}
						length() {
							return this.g.length;
						}
						end() {
							const t = this.g;
							return this.g = [], t;
						}
					}();
				}
			}();
			Zr(this.v, e, jr(Cr, qr, $r, t)), ur(e, e.g.end());
			const n = new Uint8Array(e.h), r = e.l, i = r.length;
			let s = 0;
			for (let t = 0; t < i; t++) {
				const e = r[t];
				n.set(e, s), s += e.length;
			}
			return e.l = [n], n;
		};
	}
	var Bi = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, Gi = [
		0,
		xi,
		ei((function(t, e, n) {
			return 2 === t.h && (ri(e, n, (t = $n(t)) === R() ? void 0 : t), !0);
		}), (function(t, e, n) {
			if (null != e) {
				if (e instanceof Lr) {
					const r = e.Ra;
					r ? (e = r(e), null != e && pr(t, n, Pn(e, !0).buffer)) : U(K, 3);
					return;
				}
				if (Array.isArray(e)) return void U(K, 3);
			}
			li(t, e, n);
		}), kr)
	];
	var ji, Vi = globalThis.trustedTypes;
	function Xi(t) {
		var e;
		return void 0 === ji && (ji = function() {
			let t = null;
			if (!Vi) return t;
			try {
				const e = (t) => t;
				t = Vi.createPolicy("goog#html", {
					createHTML: e,
					createScript: e,
					createScriptURL: e
				});
			} catch (t) {}
			return t;
		}()), t = (e = ji) ? e.createScriptURL(t) : t, new class {
			constructor(t) {
				this.g = t;
			}
			toString() {
				return this.g + "";
			}
		}(t);
	}
	function Hi(t, ...e) {
		if (0 === e.length) return Xi(t[0]);
		let n = t[0];
		for (let r = 0; r < e.length; r++) n += encodeURIComponent(e[r]) + t[r + 1];
		return Xi(n);
	}
	var Wi = [
		0,
		wi,
		Ci,
		bi,
		-1,
		Ti,
		Ci,
		-1,
		bi
	], zi = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, Ki = [
		0,
		bi,
		Li,
		bi,
		Ci,
		-1,
		ni((function(t, e, n) {
			return (0 === t.h || 2 === t.h) && (e = un(e, 0 | e[Q], n), 2 == t.h ? Jn(t, Bn, e) : e.push(Nn(t.g)), !0);
		}), (function(t, e, n) {
			if (null != (e = ti(ee, e)) && e.length) {
				n = fr(t, n);
				for (let n = 0; n < e.length; n++) cr(t.g, e[n]);
				dr(t, n);
			}
		}), Sr),
		Li,
		-1,
		[
			0,
			bi,
			-1
		],
		Ci,
		bi,
		-1
	], Yi = [
		0,
		3,
		bi,
		-1,
		2,
		[
			0,
			[2],
			wi,
			Ii,
			[0, ei((function(t, e, n) {
				return 0 === t.h && (ri(e, n, Un(t.g)), !0);
			}), fi, wr)]
		],
		[
			0,
			Ci,
			bi,
			Ci,
			bi,
			Ci,
			bi,
			Li,
			-1
		],
		[
			0,
			[3, 4],
			Li,
			-1,
			Ii,
			[0, wi],
			Ii,
			[0, Ci]
		],
		[0]
	], qi = [
		0,
		Li,
		-2
	], $i = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, Ji = [0], Zi = [
		0,
		wi,
		bi,
		1,
		bi,
		-4
	], Qi = class extends Lr {
		constructor(t) {
			super(t, 2);
		}
	}, ts = {};
	ts[336783863] = [
		0,
		Li,
		bi,
		-1,
		wi,
		[
			0,
			[
				1,
				2,
				3,
				4,
				5,
				6,
				7,
				8,
				9
			],
			Ii,
			Ji,
			Ii,
			Ki,
			Ii,
			qi,
			Ii,
			Zi,
			Ii,
			Wi,
			Ii,
			[
				0,
				Li,
				-2
			],
			Ii,
			[
				0,
				Li,
				Ci
			],
			Ii,
			Yi,
			Ii,
			[
				0,
				Ci,
				-1,
				bi
			]
		],
		[0, Li],
		bi,
		[
			0,
			[1, 3],
			[2, 4],
			Ii,
			[0, Ti],
			-1,
			Ii,
			[0, Si],
			-1,
			Ri,
			[
				0,
				Li,
				-1
			]
		],
		Li
	];
	var es = [
		0,
		vi,
		-1,
		ki,
		-3,
		vi,
		Ti,
		xi,
		Ai,
		vi,
		-1,
		ki,
		Ai,
		ki,
		-2,
		xi
	];
	function ns(t, e) {
		Fn(t, 3, e);
	}
	function rs(t, e) {
		Fn(t, 4, e);
	}
	var is = class extends Lr {
		constructor(t) {
			super(t, 500);
		}
		o(t) {
			return wn(this, 0, 7, t);
		}
	}, ss = [-1, {}], os = [
		0,
		Li,
		1,
		ss
	], as = [
		0,
		Li,
		Si,
		ss
	];
	function cs(t, e) {
		bn(t, 1, is, e);
	}
	function hs(t, e) {
		Fn(t, 10, e);
	}
	function us(t, e) {
		Fn(t, 15, e);
	}
	var ls = class extends Lr {
		constructor(t) {
			super(t, 500);
		}
		o(t) {
			return wn(this, 0, 1001, t);
		}
	}, fs = [
		-500,
		Ri,
		[
			-500,
			xi,
			-1,
			Si,
			-3,
			[
				-2,
				ts,
				bi
			],
			Ri,
			Gi,
			Ai,
			-1,
			os,
			as,
			Ri,
			[
				0,
				xi,
				ki
			],
			xi,
			es,
			Ai,
			Si,
			987,
			Si
		],
		4,
		Ri,
		[
			-500,
			Li,
			-1,
			[-1, {}],
			998,
			Li
		],
		Ri,
		[
			-500,
			Li,
			Si,
			-1,
			[
				-2,
				{},
				bi
			],
			997,
			Si,
			-1
		],
		Ai,
		Ri,
		[
			-500,
			Li,
			Si,
			ss,
			998,
			Si
		],
		Si,
		Ai,
		os,
		as,
		Ri,
		[
			0,
			xi,
			-1,
			ss
		],
		Si,
		-2,
		es,
		xi,
		-1,
		ki,
		[
			0,
			ki,
			Pi
		],
		978,
		ss,
		Ri,
		Gi
	];
	ls.prototype.g = Di(fs);
	var ds = Ui(ls, fs), ps = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, gs = class extends Lr {
		constructor(t) {
			super(t);
		}
		g() {
			return vn(this, ps, 1);
		}
	}, ms = [
		0,
		Ri,
		[
			0,
			wi,
			pi,
			Li,
			-1
		]
	], ys = Ui(gs, ms), _s = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, vs = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, Es = class extends Lr {
		constructor(t) {
			super(t);
		}
		l() {
			return yn(this, _s, 2);
		}
		g() {
			return vn(this, vs, 5);
		}
	}, ws = Ui(class extends Lr {
		constructor(t) {
			super(t);
		}
	}, [
		0,
		Si,
		Ti,
		mi,
		[
			0,
			Ci,
			[
				0,
				wi,
				-3
			],
			[
				0,
				pi,
				-3
			],
			[
				0,
				wi,
				-1,
				[
					0,
					Ri,
					[
						0,
						wi,
						-2
					]
				]
			],
			Ri,
			[
				0,
				pi,
				-1,
				Li,
				pi
			]
		],
		Li,
		-1,
		_i,
		Ri,
		[
			0,
			wi,
			pi
		],
		Si,
		_i
	]), Ts = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, As = Ui(class extends Lr {
		constructor(t) {
			super(t);
		}
	}, [
		0,
		Ri,
		[
			0,
			pi,
			-4
		]
	]), bs = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, ks = Ui(class extends Lr {
		constructor(t) {
			super(t);
		}
	}, [
		0,
		Ri,
		[
			0,
			pi,
			-4
		]
	]), Ss = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, xs = [
		0,
		wi,
		-1,
		mi,
		Ci
	], Ls = class extends Lr {
		constructor(t) {
			super(t);
		}
	};
	Ls.prototype.g = Di([
		0,
		pi,
		-4,
		_i
	]);
	var Rs = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, Is = Ui(class extends Lr {
		constructor(t) {
			super(t);
		}
	}, [
		0,
		Ri,
		[
			0,
			1,
			wi,
			Li,
			ms
		],
		_i
	]), Fs = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, Ms = class extends Lr {
		constructor(t) {
			super(t);
		}
		na() {
			const t = $e(this, 1, void 0, void 0, an);
			return null == t ? R() : t;
		}
	}, Ps = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, Cs = [1, 2], Os = Ui(class extends Lr {
		constructor(t) {
			super(t);
		}
	}, [
		0,
		Ri,
		[
			0,
			Cs,
			Ii,
			[0, mi],
			Ii,
			[0, Fi],
			wi,
			Li
		],
		_i
	]), Ns = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, Us = [
		0,
		Li,
		wi,
		pi,
		Si,
		-1
	], Ds = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, Bs = [
		0,
		bi,
		-1
	], Gs = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, js = [
		1,
		2,
		3,
		4,
		5,
		6
	], Vs = class extends Lr {
		constructor(t) {
			super(t);
		}
		g() {
			return null != $e(this, 1, void 0, void 0, an);
		}
		l() {
			return null != le($e(this, 2));
		}
	}, Xs = class extends Lr {
		constructor(t) {
			super(t);
		}
		g() {
			return Zt($e(this, 2)) ?? !1;
		}
	}, Hs = [
		0,
		Fi,
		Li,
		[
			0,
			wi,
			_i,
			-1
		],
		[
			0,
			Ei,
			_i
		]
	], Ws = [
		0,
		Hs,
		bi,
		[
			0,
			js,
			Ii,
			Zi,
			Ii,
			Ki,
			Ii,
			Wi,
			Ii,
			Ji,
			Ii,
			qi,
			Ii,
			Yi
		],
		Ci
	], zs = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, Ks = [
		0,
		Ws,
		pi,
		-1,
		wi
	], Ys = Ni(502141897, zs);
	ts[502141897] = Ks;
	var qs = Ui(class extends Lr {
		constructor(t) {
			super(t);
		}
	}, [
		0,
		[
			0,
			Ci,
			-1,
			gi,
			Mi
		],
		xs
	]), $s = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, Js = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, Zs = [
		0,
		Ws,
		pi,
		[0, Ws],
		bi
	], Qs = Ni(508968150, Js);
	ts[508968150] = [
		0,
		Ws,
		Ks,
		Zs,
		pi,
		[0, [0, Hs]]
	], ts[508968149] = Zs;
	var to = class extends Lr {
		constructor(t) {
			super(t);
		}
		l() {
			return yn(this, Ns, 2);
		}
		g() {
			Ze(this, 2);
		}
	}, eo = [
		0,
		Ws,
		Us
	];
	ts[478825465] = eo;
	var no = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, ro = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, io = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, so = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, oo = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, ao = [
		0,
		Ws,
		[0, Ws],
		eo,
		-1
	], co = [
		0,
		Ws,
		pi,
		wi
	], ho = [
		0,
		Ws,
		pi
	], uo = [
		0,
		Ws,
		co,
		ho,
		pi
	], lo = Ni(479097054, oo);
	ts[479097054] = [
		0,
		Ws,
		uo,
		ao
	], ts[463370452] = ao, ts[464864288] = co;
	var fo = Ni(462713202, so);
	ts[462713202] = uo, ts[474472470] = ho;
	var po = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, go = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, mo = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, yo = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, _o = [
		0,
		Ws,
		pi,
		-1,
		wi
	], vo = [
		0,
		Ws,
		pi,
		bi
	];
	yo.prototype.g = Di([
		0,
		Ws,
		ho,
		[0, Ws],
		Ks,
		Zs,
		_o,
		vo
	]);
	var Eo = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, wo = Ni(456383383, Eo);
	ts[456383383] = [
		0,
		Ws,
		Us
	];
	var To = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, Ao = Ni(476348187, To);
	ts[476348187] = [
		0,
		Ws,
		Bs
	];
	var bo = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, ko = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, So = [
		0,
		Ci,
		-1
	], xo = Ni(458105876, class extends Lr {
		constructor(t) {
			super(t);
		}
		g() {
			let t;
			var e = this.v;
			const n = 0 | e[Q];
			return t = at(this, n), e = function(t, e, n, r) {
				var i = ko;
				!r && He(t) && (n = 0 | (e = t.v)[Q]);
				var s = Je(e, 2);
				if (t = !1, null == s) {
					if (r) return be();
					s = [];
				} else if (s.constructor === Ee) {
					if (!(2 & s.J) || r) return s;
					s = s.V();
				} else Array.isArray(s) ? t = !!(2 & (0 | s[Q])) : s = [];
				if (r) {
					if (!s.length) return be();
					t || (t = !0, it(s));
				} else t && (t = !1, st(s), s = cn(s));
				return !t && 32 & n && nt(s, 32), n = Qe(e, n, 2, r = new Ee(s, i, de, void 0)), t || ze(e, n), r;
			}(this, e, n, t), !t && ko && (e.ra = !0), e;
		}
	});
	ts[458105876] = [
		0,
		So,
		ii,
		[
			!0,
			_i,
			[
				0,
				Li,
				-1,
				Si
			]
		],
		[
			0,
			Ti,
			bi,
			Ci
		]
	];
	var Lo = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, Ro = Ni(458105758, Lo);
	ts[458105758] = [
		0,
		Ws,
		Li,
		So
	];
	var Io = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, Fo = [
		0,
		yi,
		-1,
		ki
	], Mo = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, Po = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, Co = [1, 2];
	Po.prototype.g = Di([
		0,
		Co,
		Ii,
		Fo,
		Ii,
		[
			0,
			Ri,
			Fo
		]
	]);
	var Oo = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, No = Ni(443442058, Oo);
	ts[443442058] = [
		0,
		Ws,
		Li,
		wi,
		pi,
		Si,
		-1,
		bi,
		pi
	], ts[514774813] = _o;
	var Uo = class extends Lr {
		constructor(t) {
			super(t);
		}
	}, Do = Ni(516587230, Uo);
	function Bo(t, e) {
		return e = e ? e.clone() : new Ns(), void 0 !== t.displayNamesLocale ? Ze(e, 1, ue(t.displayNamesLocale)) : void 0 === t.displayNamesLocale && Ze(e, 1), void 0 !== t.maxResults ? xn(e, 2, t.maxResults) : "maxResults" in t && Ze(e, 2), void 0 !== t.scoreThreshold ? Ln(e, 3, t.scoreThreshold) : "scoreThreshold" in t && Ze(e, 3), void 0 !== t.categoryAllowlist ? In(e, 4, t.categoryAllowlist) : "categoryAllowlist" in t && Ze(e, 4), void 0 !== t.categoryDenylist ? In(e, 5, t.categoryDenylist) : "categoryDenylist" in t && Ze(e, 5), e;
	}
	function Go(t) {
		const e = Number(t);
		return Number.isSafeInteger(e) ? e : String(t);
	}
	function jo(t, e = -1, n = "") {
		return {
			categories: t.map(((t) => ({
				index: kn(t, 1) ?? 0 ?? -1,
				score: Sn(t, 2) ?? 0,
				categoryName: le($e(t, 3)) ?? "" ?? "",
				displayName: le($e(t, 4)) ?? "" ?? ""
			}))),
			headIndex: e,
			headName: n
		};
	}
	function Vo(t) {
		const e = { classifications: vn(t, Rs, 1).map(((t) => jo(yn(t, gs, 4)?.g() ?? [], kn(t, 2) ?? 0, le($e(t, 3)) ?? ""))) };
		return null != function(t) {
			return null == t ? t : "bigint" == typeof t ? (wt(t) ? t = Number(t) : (t = Xt(64, t), t = wt(t) ? Number(t) : String(t)), t) : te(t) ? "number" == typeof t ? ie(t) : se(t) : void 0;
		}($e(t, 2, void 0, void 0, ce)) && (e.timestampMs = Go($e(t, 2, void 0, void 0, ce) ?? Ye)), e;
	}
	function Xo(t) {
		var e = en(t, 3, $t, tn()), n = en(t, 2, ee, tn()), r = en(t, 1, le, tn()), i = en(t, 9, le, tn());
		const s = {
			categories: [],
			keypoints: []
		};
		for (let t = 0; t < e.length; t++) s.categories.push({
			score: e[t],
			index: n[t] ?? -1,
			categoryName: r[t] ?? "",
			displayName: i[t] ?? ""
		});
		if ((e = yn(t, Es, 4)?.l()) && (s.boundingBox = {
			originX: kn(e, 1, qe) ?? 0,
			originY: kn(e, 2, qe) ?? 0,
			width: kn(e, 3, qe) ?? 0,
			height: kn(e, 4, qe) ?? 0,
			angle: 0
		}), yn(t, Es, 4)?.g().length) for (const e of yn(t, Es, 4).g()) s.keypoints.push({
			x: $e(e, 1, void 0, qe, $t) ?? 0,
			y: $e(e, 2, void 0, qe, $t) ?? 0,
			score: $e(e, 4, void 0, qe, $t) ?? 0,
			label: le($e(e, 3, void 0, qe)) ?? ""
		});
		return s;
	}
	function Ho(t) {
		const e = [];
		for (const n of vn(t, bs, 1)) e.push({
			x: Sn(n, 1) ?? 0,
			y: Sn(n, 2) ?? 0,
			z: Sn(n, 3) ?? 0,
			visibility: Sn(n, 4) ?? 0
		});
		return e;
	}
	function Wo(t) {
		const e = [];
		for (const n of vn(t, Ts, 1)) e.push({
			x: Sn(n, 1) ?? 0,
			y: Sn(n, 2) ?? 0,
			z: Sn(n, 3) ?? 0,
			visibility: Sn(n, 4) ?? 0
		});
		return e;
	}
	function zo(t) {
		return Array.from(t, ((t) => t > 127 ? t - 256 : t));
	}
	function Ko(t, e) {
		if (t.length !== e.length) throw Error(`Cannot compute cosine similarity between embeddings of different sizes (${t.length} vs. ${e.length}).`);
		let n = 0, r = 0, i = 0;
		for (let s = 0; s < t.length; s++) n += t[s] * e[s], r += t[s] * t[s], i += e[s] * e[s];
		if (r <= 0 || i <= 0) throw Error("Cannot compute cosine similarity on embedding with 0 norm.");
		return n / Math.sqrt(r * i);
	}
	var Yo;
	ts[516587230] = [
		0,
		Ws,
		_o,
		vo,
		pi
	], ts[518928384] = vo;
	var qo = new Uint8Array([
		0,
		97,
		115,
		109,
		1,
		0,
		0,
		0,
		1,
		5,
		1,
		96,
		0,
		1,
		123,
		3,
		2,
		1,
		0,
		10,
		10,
		1,
		8,
		0,
		65,
		0,
		253,
		15,
		253,
		98,
		11
	]);
	async function $o(t) {
		if (t) return !0;
		if (void 0 === Yo) try {
			await WebAssembly.instantiate(qo), Yo = !0;
		} catch {
			Yo = !1;
		}
		return Yo;
	}
	async function Jo(t, e, n) {
		return {
			wasmLoaderPath: `${e}/${t}_${n = `wasm${n ? "_module" : ""}${await $o(n) ? "" : "_nosimd"}_internal`}.js`,
			wasmBinaryPath: `${e}/${t}_${n}.wasm`
		};
	}
	var Zo = class {};
	function Qo() {
		var t = navigator;
		return "undefined" != typeof OffscreenCanvas && (!function(t = navigator) {
			return (t = t.userAgent).includes("Safari") && !t.includes("Chrome");
		}(t) || !!((t = t.userAgent.match(/Version\/([\d]+).*Safari/)) && t.length >= 1 && Number(t[1]) >= 17));
	}
	async function ta(t) {
		if ("function" != typeof importScripts) {
			const e = document.createElement("script");
			return e.src = t.toString(), e.crossOrigin = "anonymous", new Promise(((t, n) => {
				e.addEventListener("load", (() => {
					t();
				}), !1), e.addEventListener("error", ((t) => {
					n(t);
				}), !1), document.body.appendChild(e);
			}));
		}
		try {
			importScripts(t.toString());
		} catch (e) {
			if (!(e instanceof TypeError)) throw e;
			{
				const e = self.import;
				e ? await e(t.toString()) : await import(t.toString());
			}
		}
	}
	function ea(t) {
		return void 0 !== t.videoWidth ? [t.videoWidth, t.videoHeight] : void 0 !== t.naturalWidth ? [t.naturalWidth, t.naturalHeight] : void 0 !== t.displayWidth ? [t.displayWidth, t.displayHeight] : [t.width, t.height];
	}
	function na(t, e, n) {
		t.m || console.error("No wasm multistream support detected: ensure dependency inclusion of :gl_graph_runner_internal_multi_input target"), n(e = t.i.stringToNewUTF8(e)), t.i._free(e);
	}
	function ra(t, e, n) {
		if (!t.i.canvas) throw Error("No OpenGL canvas configured.");
		if (n ? t.i._bindTextureToStream(n) : t.i._bindTextureToCanvas(), !(n = t.i.canvas.getContext("webgl2") || t.i.canvas.getContext("webgl"))) throw Error("Failed to obtain WebGL context from the provided canvas. `getContext()` should only be invoked with `webgl` or `webgl2`.");
		t.i.gpuOriginForWebTexturesIsBottomLeft && n.pixelStorei(n.UNPACK_FLIP_Y_WEBGL, !0), n.texImage2D(n.TEXTURE_2D, 0, n.RGBA, n.RGBA, n.UNSIGNED_BYTE, e), t.i.gpuOriginForWebTexturesIsBottomLeft && n.pixelStorei(n.UNPACK_FLIP_Y_WEBGL, !1);
		const [r, i] = ea(e);
		return !t.l || r === t.i.canvas.width && i === t.i.canvas.height || (t.i.canvas.width = r, t.i.canvas.height = i), [r, i];
	}
	function ia(t, e, n) {
		t.m || console.error("No wasm multistream support detected: ensure dependency inclusion of :gl_graph_runner_internal_multi_input target");
		const r = new Uint32Array(e.length);
		for (let n = 0; n < e.length; n++) r[n] = t.i.stringToNewUTF8(e[n]);
		e = t.i._malloc(4 * r.length), t.i.HEAPU32.set(r, e >> 2), n(e);
		for (const e of r) t.i._free(e);
		t.i._free(e);
	}
	function sa(t, e, n) {
		t.i.simpleListeners = t.i.simpleListeners || {}, t.i.simpleListeners[e] = n;
	}
	function oa(t, e, n) {
		let r = [];
		t.i.simpleListeners = t.i.simpleListeners || {}, t.i.simpleListeners[e] = (t, e, i) => {
			e ? (n(r, i), r = []) : r.push(t);
		};
	}
	Zo.forVisionTasks = function(t, e = !1) {
		return Jo("vision", t ?? Hi``, e);
	}, Zo.forTextTasks = function(t, e = !1) {
		return Jo("text", t ?? Hi``, e);
	}, Zo.forGenAiTasks = function(t, e = !1) {
		return Jo("genai", t ?? Hi``, e);
	}, Zo.forAudioTasks = function(t, e = !1) {
		return Jo("audio", t ?? Hi``, e);
	}, Zo.isSimdSupported = function(t = !1) {
		return $o(t);
	};
	async function aa(t, e, n, r) {
		return t = await (async (t, e, n, r, i) => {
			if (e && await ta(e), !self.ModuleFactory) throw Error("ModuleFactory not set.");
			if (n && (await ta(n), !self.ModuleFactory)) throw Error("ModuleFactory not set.");
			return self.Module && i && ((e = self.Module).locateFile = i.locateFile, i.mainScriptUrlOrBlob && (e.mainScriptUrlOrBlob = i.mainScriptUrlOrBlob)), i = await self.ModuleFactory(self.Module || i), self.ModuleFactory = self.Module = void 0, new t(i, r);
		})(t, n.wasmLoaderPath, n.assetLoaderPath, e, { locateFile: (t) => t.endsWith(".wasm") ? n.wasmBinaryPath.toString() : n.assetBinaryPath && t.endsWith(".data") ? n.assetBinaryPath.toString() : t }), await t.o(r), t;
	}
	function ca(t, e) {
		const n = yn(t.baseOptions, Vs, 1) || new Vs();
		"string" == typeof e ? (Ze(n, 2, ue(e)), Ze(n, 1)) : e instanceof Uint8Array && (Ze(n, 1, ht(e, !1)), Ze(n, 2)), wn(t.baseOptions, 0, 1, n);
	}
	function ha(t) {
		try {
			const e = t.H.length;
			if (1 === e) throw Error(t.H[0].message);
			if (e > 1) throw Error("Encountered multiple errors: " + t.H.map(((t) => t.message)).join(", "));
		} finally {
			t.H = [];
		}
	}
	function ua(t, e) {
		t.C = Math.max(t.C, e);
	}
	function la(t, e) {
		t.B = new is(), Rn(t.B, 2, "PassThroughCalculator"), ns(t.B, "free_memory"), rs(t.B, "free_memory_unused_out"), hs(e, "free_memory"), cs(e, t.B);
	}
	function fa(t, e) {
		ns(t.B, e), rs(t.B, e + "_unused_out");
	}
	function da(t) {
		t.g.addBoolToStream(!0, "free_memory", t.C);
	}
	var pa = class {
		constructor(t) {
			this.g = t, this.H = [], this.C = 0, this.g.setAutoRenderToScreen(!1);
		}
		l(t, e = !0) {
			if (e) {
				const e = t.baseOptions || {};
				if (t.baseOptions?.modelAssetBuffer && t.baseOptions?.modelAssetPath) throw Error("Cannot set both baseOptions.modelAssetPath and baseOptions.modelAssetBuffer");
				if (!(yn(this.baseOptions, Vs, 1)?.g() || yn(this.baseOptions, Vs, 1)?.l() || t.baseOptions?.modelAssetBuffer || t.baseOptions?.modelAssetPath)) throw Error("Either baseOptions.modelAssetPath or baseOptions.modelAssetBuffer must be set");
				if (function(t, e) {
					let n = yn(t.baseOptions, Gs, 3);
					if (!n) {
						var r = n = new Gs(), i = new $i();
						Tn(r, 4, js, i);
					}
					"delegate" in e && ("GPU" === e.delegate ? (e = n, r = new zi(), Tn(e, 2, js, r)) : (e = n, r = new $i(), Tn(e, 4, js, r))), wn(t.baseOptions, 0, 3, n);
				}(this, e), e.modelAssetPath) return fetch(e.modelAssetPath.toString()).then(((t) => {
					if (t.ok) return t.arrayBuffer();
					throw Error(`Failed to fetch model: ${e.modelAssetPath} (${t.status})`);
				})).then(((t) => {
					try {
						this.g.i.FS_unlink("/model.dat");
					} catch {}
					this.g.i.FS_createDataFile("/", "model.dat", new Uint8Array(t), !0, !1, !1), ca(this, "/model.dat"), this.m(), this.L();
				}));
				if (e.modelAssetBuffer instanceof Uint8Array) ca(this, e.modelAssetBuffer);
				else if (e.modelAssetBuffer) return async function(t) {
					const e = [];
					for (var n = 0;;) {
						const { done: r, value: i } = await t.read();
						if (r) break;
						e.push(i), n += i.length;
					}
					if (0 === e.length) return new Uint8Array(0);
					if (1 === e.length) return e[0];
					t = new Uint8Array(n), n = 0;
					for (const r of e) t.set(r, n), n += r.length;
					return t;
				}(e.modelAssetBuffer).then(((t) => {
					ca(this, t), this.m(), this.L();
				}));
			}
			return this.m(), this.L(), Promise.resolve();
		}
		L() {}
		ca() {
			let t;
			if (this.g.ca(((e) => {
				t = ds(e);
			})), !t) throw Error("Failed to retrieve CalculatorGraphConfig");
			return t;
		}
		setGraph(t, e) {
			this.g.attachErrorListener(((t, e) => {
				this.H.push(Error(e));
			})), this.g.Ja(), this.g.setGraph(t, e), this.B = void 0, ha(this);
		}
		finishProcessing() {
			this.g.finishProcessing(), ha(this);
		}
		close() {
			this.B = void 0, this.g.closeGraph();
		}
	};
	function ga(t, e) {
		if (!t) throw Error(`Unable to obtain required WebGL resource: ${e}`);
		return t;
	}
	pa.prototype.close = pa.prototype.close;
	var ma = class {
		constructor(t, e, n, r) {
			this.g = t, this.h = e, this.m = n, this.l = r;
		}
		bind() {
			this.g.bindVertexArray(this.h);
		}
		close() {
			this.g.deleteVertexArray(this.h), this.g.deleteBuffer(this.m), this.g.deleteBuffer(this.l);
		}
	};
	function ya(t, e, n) {
		const r = t.g;
		if (n = ga(r.createShader(n), "Failed to create WebGL shader"), r.shaderSource(n, e), r.compileShader(n), !r.getShaderParameter(n, r.COMPILE_STATUS)) throw Error(`Could not compile WebGL shader: ${r.getShaderInfoLog(n)}`);
		return r.attachShader(t.h, n), n;
	}
	function _a(t, e) {
		const n = t.g, r = ga(n.createVertexArray(), "Failed to create vertex array");
		n.bindVertexArray(r);
		const i = ga(n.createBuffer(), "Failed to create buffer");
		n.bindBuffer(n.ARRAY_BUFFER, i), n.enableVertexAttribArray(t.O), n.vertexAttribPointer(t.O, 2, n.FLOAT, !1, 0, 0), n.bufferData(n.ARRAY_BUFFER, new Float32Array([
			-1,
			-1,
			-1,
			1,
			1,
			1,
			1,
			-1
		]), n.STATIC_DRAW);
		const s = ga(n.createBuffer(), "Failed to create buffer");
		return n.bindBuffer(n.ARRAY_BUFFER, s), n.enableVertexAttribArray(t.L), n.vertexAttribPointer(t.L, 2, n.FLOAT, !1, 0, 0), n.bufferData(n.ARRAY_BUFFER, new Float32Array(e ? [
			0,
			1,
			0,
			0,
			1,
			0,
			1,
			1
		] : [
			0,
			0,
			0,
			1,
			1,
			1,
			1,
			0
		]), n.STATIC_DRAW), n.bindBuffer(n.ARRAY_BUFFER, null), n.bindVertexArray(null), new ma(n, r, i, s);
	}
	function va(t, e) {
		if (t.g) {
			if (e !== t.g) throw Error("Cannot change GL context once initialized");
		} else t.g = e;
	}
	function Ea(t, e, n, r) {
		return va(t, e), t.h || (t.m(), t.D()), n ? (t.u || (t.u = _a(t, !0)), n = t.u) : (t.A || (t.A = _a(t, !1)), n = t.A), e.useProgram(t.h), n.bind(), t.l(), t = r(), n.g.bindVertexArray(null), t;
	}
	function wa(t, e, n) {
		return va(t, e), t = ga(e.createTexture(), "Failed to create texture"), e.bindTexture(e.TEXTURE_2D, t), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_S, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_WRAP_T, e.CLAMP_TO_EDGE), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MIN_FILTER, n ?? e.LINEAR), e.texParameteri(e.TEXTURE_2D, e.TEXTURE_MAG_FILTER, n ?? e.LINEAR), e.bindTexture(e.TEXTURE_2D, null), t;
	}
	function Ta(t, e, n) {
		va(t, e), t.B || (t.B = ga(e.createFramebuffer(), "Failed to create framebuffe.")), e.bindFramebuffer(e.FRAMEBUFFER, t.B), e.framebufferTexture2D(e.FRAMEBUFFER, e.COLOR_ATTACHMENT0, e.TEXTURE_2D, n, 0);
	}
	function Aa(t) {
		t.g?.bindFramebuffer(t.g.FRAMEBUFFER, null);
	}
	var ba = class {
		H() {
			return "\n  precision mediump float;\n  varying vec2 vTex;\n  uniform sampler2D inputTexture;\n  void main() {\n    gl_FragColor = texture2D(inputTexture, vTex);\n  }\n ";
		}
		m() {
			const t = this.g;
			if (this.h = ga(t.createProgram(), "Failed to create WebGL program"), this.X = ya(this, "\n  attribute vec2 aVertex;\n  attribute vec2 aTex;\n  varying vec2 vTex;\n  void main(void) {\n    gl_Position = vec4(aVertex, 0.0, 1.0);\n    vTex = aTex;\n  }", t.VERTEX_SHADER), this.W = ya(this, this.H(), t.FRAGMENT_SHADER), t.linkProgram(this.h), !t.getProgramParameter(this.h, t.LINK_STATUS)) throw Error(`Error during program linking: ${t.getProgramInfoLog(this.h)}`);
			this.O = t.getAttribLocation(this.h, "aVertex"), this.L = t.getAttribLocation(this.h, "aTex");
		}
		D() {}
		l() {}
		close() {
			if (this.h) {
				const t = this.g;
				t.deleteProgram(this.h), t.deleteShader(this.X), t.deleteShader(this.W);
			}
			this.B && this.g.deleteFramebuffer(this.B), this.A && this.A.close(), this.u && this.u.close();
		}
	};
	var ka = class extends ba {
		H() {
			return "\n  precision mediump float;\n  uniform sampler2D backgroundTexture;\n  uniform sampler2D maskTexture;\n  uniform sampler2D colorMappingTexture;\n  varying vec2 vTex;\n  void main() {\n    vec4 backgroundColor = texture2D(backgroundTexture, vTex);\n    float category = texture2D(maskTexture, vTex).r;\n    vec4 categoryColor = texture2D(colorMappingTexture, vec2(category, 0.0));\n    gl_FragColor = mix(backgroundColor, categoryColor, categoryColor.a);\n  }\n ";
		}
		D() {
			const t = this.g;
			t.activeTexture(t.TEXTURE1), this.C = wa(this, t, t.LINEAR), t.activeTexture(t.TEXTURE2), this.j = wa(this, t, t.NEAREST);
		}
		m() {
			super.m();
			const t = this.g;
			this.P = ga(t.getUniformLocation(this.h, "backgroundTexture"), "Uniform location"), this.U = ga(t.getUniformLocation(this.h, "colorMappingTexture"), "Uniform location"), this.M = ga(t.getUniformLocation(this.h, "maskTexture"), "Uniform location");
		}
		l() {
			super.l();
			const t = this.g;
			t.uniform1i(this.M, 0), t.uniform1i(this.P, 1), t.uniform1i(this.U, 2);
		}
		close() {
			this.C && this.g.deleteTexture(this.C), this.j && this.g.deleteTexture(this.j), super.close();
		}
	}, Sa = class extends ba {
		H() {
			return "\n  precision mediump float;\n  uniform sampler2D maskTexture;\n  uniform sampler2D defaultTexture;\n  uniform sampler2D overlayTexture;\n  varying vec2 vTex;\n  void main() {\n    float confidence = texture2D(maskTexture, vTex).r;\n    vec4 defaultColor = texture2D(defaultTexture, vTex);\n    vec4 overlayColor = texture2D(overlayTexture, vTex);\n    // Apply the alpha from the overlay and merge in the default color\n    overlayColor = mix(defaultColor, overlayColor, overlayColor.a);\n    gl_FragColor = mix(defaultColor, overlayColor, confidence);\n  }\n ";
		}
		D() {
			const t = this.g;
			t.activeTexture(t.TEXTURE1), this.j = wa(this, t), t.activeTexture(t.TEXTURE2), this.C = wa(this, t);
		}
		m() {
			super.m();
			const t = this.g;
			this.M = ga(t.getUniformLocation(this.h, "defaultTexture"), "Uniform location"), this.P = ga(t.getUniformLocation(this.h, "overlayTexture"), "Uniform location"), this.I = ga(t.getUniformLocation(this.h, "maskTexture"), "Uniform location");
		}
		l() {
			super.l();
			const t = this.g;
			t.uniform1i(this.I, 0), t.uniform1i(this.M, 1), t.uniform1i(this.P, 2);
		}
		close() {
			this.j && this.g.deleteTexture(this.j), this.C && this.g.deleteTexture(this.C), super.close();
		}
	};
	function xa(t, e) {
		switch (e) {
			case 0: return t.g.find(((t) => t instanceof Uint8Array));
			case 1: return t.g.find(((t) => t instanceof Float32Array));
			case 2: return t.g.find(((t) => "undefined" != typeof WebGLTexture && t instanceof WebGLTexture));
			default: throw Error(`Type is not supported: ${e}`);
		}
	}
	function La(t) {
		var e = xa(t, 1);
		if (!e) {
			if (e = xa(t, 0)) e = new Float32Array(e).map(((t) => t / 255));
			else {
				e = new Float32Array(t.width * t.height);
				const r = Ia(t);
				var n = Ma(t);
				if (Ta(n, r, Ra(t)), "iPad Simulator;iPhone Simulator;iPod Simulator;iPad;iPhone;iPod".split(";").includes(navigator.platform) || navigator.userAgent.includes("Mac") && "document" in self && "ontouchend" in self.document) {
					n = new Float32Array(t.width * t.height * 4), r.readPixels(0, 0, t.width, t.height, r.RGBA, r.FLOAT, n);
					for (let t = 0, r = 0; t < e.length; ++t, r += 4) e[t] = n[r];
				} else r.readPixels(0, 0, t.width, t.height, r.RED, r.FLOAT, e);
			}
			t.g.push(e);
		}
		return e;
	}
	function Ra(t) {
		let e = xa(t, 2);
		if (!e) {
			const n = Ia(t);
			e = Pa(t);
			const r = La(t), i = Fa(t);
			n.texImage2D(n.TEXTURE_2D, 0, i, t.width, t.height, 0, n.RED, n.FLOAT, r), Ca(t);
		}
		return e;
	}
	function Ia(t) {
		if (!t.canvas) throw Error("Conversion to different image formats require that a canvas is passed when initializing the image.");
		return t.h || (t.h = ga(t.canvas.getContext("webgl2"), "You cannot use a canvas that is already bound to a different type of rendering context.")), t.h;
	}
	function Fa(t) {
		if (t = Ia(t), !Oa) if (t.getExtension("EXT_color_buffer_float") && t.getExtension("OES_texture_float_linear") && t.getExtension("EXT_float_blend")) Oa = t.R32F;
		else {
			if (!t.getExtension("EXT_color_buffer_half_float")) throw Error("GPU does not fully support 4-channel float32 or float16 formats");
			Oa = t.R16F;
		}
		return Oa;
	}
	function Ma(t) {
		return t.l || (t.l = new ba()), t.l;
	}
	function Pa(t) {
		const e = Ia(t);
		e.viewport(0, 0, t.width, t.height), e.activeTexture(e.TEXTURE0);
		let n = xa(t, 2);
		return n || (n = wa(Ma(t), e, t.m ? e.LINEAR : e.NEAREST), t.g.push(n), t.j = !0), e.bindTexture(e.TEXTURE_2D, n), n;
	}
	function Ca(t) {
		t.h.bindTexture(t.h.TEXTURE_2D, null);
	}
	var Oa, Na = class {
		constructor(t, e, n, r, i, s, o) {
			this.g = t, this.m = e, this.j = n, this.canvas = r, this.l = i, this.width = s, this.height = o, this.j && 0 === --Ua && console.error("You seem to be creating MPMask instances without invoking .close(). This leaks resources.");
		}
		Fa() {
			return !!xa(this, 0);
		}
		ka() {
			return !!xa(this, 1);
		}
		R() {
			return !!xa(this, 2);
		}
		ja() {
			return (e = xa(t = this, 0)) || (e = La(t), e = new Uint8Array(e.map(((t) => Math.round(255 * t)))), t.g.push(e)), e;
			var t, e;
		}
		ia() {
			return La(this);
		}
		N() {
			return Ra(this);
		}
		clone() {
			const t = [];
			for (const e of this.g) {
				let n;
				if (e instanceof Uint8Array) n = new Uint8Array(e);
				else if (e instanceof Float32Array) n = new Float32Array(e);
				else {
					if (!(e instanceof WebGLTexture)) throw Error(`Type is not supported: ${e}`);
					{
						const t = Ia(this), e = Ma(this);
						t.activeTexture(t.TEXTURE1), n = wa(e, t, this.m ? t.LINEAR : t.NEAREST), t.bindTexture(t.TEXTURE_2D, n);
						const r = Fa(this);
						t.texImage2D(t.TEXTURE_2D, 0, r, this.width, this.height, 0, t.RED, t.FLOAT, null), t.bindTexture(t.TEXTURE_2D, null), Ta(e, t, n), Ea(e, t, !1, (() => {
							Pa(this), t.clearColor(0, 0, 0, 0), t.clear(t.COLOR_BUFFER_BIT), t.drawArrays(t.TRIANGLE_FAN, 0, 4), Ca(this);
						})), Aa(e), Ca(this);
					}
				}
				t.push(n);
			}
			return new Na(t, this.m, this.R(), this.canvas, this.l, this.width, this.height);
		}
		close() {
			this.j && Ia(this).deleteTexture(xa(this, 2)), Ua = -1;
		}
	};
	Na.prototype.close = Na.prototype.close, Na.prototype.clone = Na.prototype.clone, Na.prototype.getAsWebGLTexture = Na.prototype.N, Na.prototype.getAsFloat32Array = Na.prototype.ia, Na.prototype.getAsUint8Array = Na.prototype.ja, Na.prototype.hasWebGLTexture = Na.prototype.R, Na.prototype.hasFloat32Array = Na.prototype.ka, Na.prototype.hasUint8Array = Na.prototype.Fa;
	var Ua = 250;
	var Da = {
		color: "white",
		lineWidth: 4,
		radius: 6
	};
	function Ba(t) {
		return {
			...Da,
			fillColor: (t = t || {}).color,
			...t
		};
	}
	function Ga(t, e) {
		return t instanceof Function ? t(e) : t;
	}
	function ja(t, e, n) {
		return Math.max(Math.min(e, n), Math.min(Math.max(e, n), t));
	}
	function Va(t) {
		if (!t.l) throw Error("CPU rendering requested but CanvasRenderingContext2D not provided.");
		return t.l;
	}
	function Xa(t) {
		if (!t.j) throw Error("GPU rendering requested but WebGL2RenderingContext not provided.");
		return t.j;
	}
	function Ha(t, e, n) {
		if (e.R()) n(e.N());
		else {
			const r = e.ka() ? e.ia() : e.ja();
			t.m = t.m ?? new ba();
			const i = Xa(t);
			n((t = new Na([r], e.m, !1, i.canvas, t.m, e.width, e.height)).N()), t.close();
		}
	}
	function Wa(t, e, n, r) {
		const i = function(t) {
			return t.g || (t.g = new ka()), t.g;
		}(t), s = Xa(t), o = Array.isArray(n) ? new ImageData(new Uint8ClampedArray(n), 1, 1) : n;
		Ea(i, s, !0, (() => {
			(function(t, e, n, r) {
				const i = t.g;
				if (i.activeTexture(i.TEXTURE0), i.bindTexture(i.TEXTURE_2D, e), i.activeTexture(i.TEXTURE1), i.bindTexture(i.TEXTURE_2D, t.C), i.texImage2D(i.TEXTURE_2D, 0, i.RGBA, i.RGBA, i.UNSIGNED_BYTE, n), t.I && function(t, e) {
					if (t !== e) return !1;
					t = t.entries(), e = e.entries();
					for (const [n, r] of t) {
						t = n;
						const i = r, s = e.next();
						if (s.done) return !1;
						const [o, a] = s.value;
						if (t !== o || i[0] !== a[0] || i[1] !== a[1] || i[2] !== a[2] || i[3] !== a[3]) return !1;
					}
					return !!e.next().done;
				}(t.I, r)) i.activeTexture(i.TEXTURE2), i.bindTexture(i.TEXTURE_2D, t.j);
				else {
					t.I = r;
					const e = Array(1024).fill(0);
					r.forEach(((t, n) => {
						if (4 !== t.length) throw Error(`Color at index ${n} is not a four-channel value.`);
						e[4 * n] = t[0], e[4 * n + 1] = t[1], e[4 * n + 2] = t[2], e[4 * n + 3] = t[3];
					})), i.activeTexture(i.TEXTURE2), i.bindTexture(i.TEXTURE_2D, t.j), i.texImage2D(i.TEXTURE_2D, 0, i.RGBA, 256, 1, 0, i.RGBA, i.UNSIGNED_BYTE, new Uint8Array(e));
				}
			})(i, e, o, r), s.clearColor(0, 0, 0, 0), s.clear(s.COLOR_BUFFER_BIT), s.drawArrays(s.TRIANGLE_FAN, 0, 4);
			const t = i.g;
			t.activeTexture(t.TEXTURE0), t.bindTexture(t.TEXTURE_2D, null), t.activeTexture(t.TEXTURE1), t.bindTexture(t.TEXTURE_2D, null), t.activeTexture(t.TEXTURE2), t.bindTexture(t.TEXTURE_2D, null);
		}));
	}
	function za(t, e, n, r) {
		const i = Xa(t), s = function(t) {
			return t.h || (t.h = new Sa()), t.h;
		}(t), o = Array.isArray(n) ? new ImageData(new Uint8ClampedArray(n), 1, 1) : n, a = Array.isArray(r) ? new ImageData(new Uint8ClampedArray(r), 1, 1) : r;
		Ea(s, i, !0, (() => {
			var t = s.g;
			t.activeTexture(t.TEXTURE0), t.bindTexture(t.TEXTURE_2D, e), t.activeTexture(t.TEXTURE1), t.bindTexture(t.TEXTURE_2D, s.j), t.texImage2D(t.TEXTURE_2D, 0, t.RGBA, t.RGBA, t.UNSIGNED_BYTE, o), t.activeTexture(t.TEXTURE2), t.bindTexture(t.TEXTURE_2D, s.C), t.texImage2D(t.TEXTURE_2D, 0, t.RGBA, t.RGBA, t.UNSIGNED_BYTE, a), i.clearColor(0, 0, 0, 0), i.clear(i.COLOR_BUFFER_BIT), i.drawArrays(i.TRIANGLE_FAN, 0, 4), i.bindTexture(i.TEXTURE_2D, null), (t = s.g).activeTexture(t.TEXTURE0), t.bindTexture(t.TEXTURE_2D, null), t.activeTexture(t.TEXTURE1), t.bindTexture(t.TEXTURE_2D, null), t.activeTexture(t.TEXTURE2), t.bindTexture(t.TEXTURE_2D, null);
		}));
	}
	var Ka = class {
		constructor(t, e) {
			"undefined" != typeof CanvasRenderingContext2D && t instanceof CanvasRenderingContext2D || t instanceof OffscreenCanvasRenderingContext2D ? (this.l = t, this.j = e) : this.j = t;
		}
		ya(t, e) {
			if (t) {
				var n = Va(this);
				e = Ba(e), n.save();
				var r = n.canvas, i = 0;
				for (const s of t) n.fillStyle = Ga(e.fillColor, {
					index: i,
					from: s
				}), n.strokeStyle = Ga(e.color, {
					index: i,
					from: s
				}), n.lineWidth = Ga(e.lineWidth, {
					index: i,
					from: s
				}), (t = new Path2D()).arc(s.x * r.width, s.y * r.height, Ga(e.radius, {
					index: i,
					from: s
				}), 0, 2 * Math.PI), n.fill(t), n.stroke(t), ++i;
				n.restore();
			}
		}
		xa(t, e, n) {
			if (t && e) {
				var r = Va(this);
				n = Ba(n), r.save();
				var i = r.canvas, s = 0;
				for (const o of e) {
					r.beginPath(), e = t[o.start];
					const a = t[o.end];
					e && a && (r.strokeStyle = Ga(n.color, {
						index: s,
						from: e,
						to: a
					}), r.lineWidth = Ga(n.lineWidth, {
						index: s,
						from: e,
						to: a
					}), r.moveTo(e.x * i.width, e.y * i.height), r.lineTo(a.x * i.width, a.y * i.height)), ++s, r.stroke();
				}
				r.restore();
			}
		}
		ua(t, e) {
			const n = Va(this);
			e = Ba(e), n.save(), n.beginPath(), n.lineWidth = Ga(e.lineWidth, {}), n.strokeStyle = Ga(e.color, {}), n.fillStyle = Ga(e.fillColor, {}), n.moveTo(t.originX, t.originY), n.lineTo(t.originX + t.width, t.originY), n.lineTo(t.originX + t.width, t.originY + t.height), n.lineTo(t.originX, t.originY + t.height), n.lineTo(t.originX, t.originY), n.stroke(), n.fill(), n.restore();
		}
		va(t, e, n = [
			0,
			0,
			0,
			255
		]) {
			this.l ? function(t, e, n, r) {
				const i = Xa(t);
				Ha(t, e, ((e) => {
					Wa(t, e, n, r), (e = Va(t)).drawImage(i.canvas, 0, 0, e.canvas.width, e.canvas.height);
				}));
			}(this, t, n, e) : Wa(this, t.N(), n, e);
		}
		wa(t, e, n) {
			this.l ? function(t, e, n, r) {
				const i = Xa(t);
				Ha(t, e, ((e) => {
					za(t, e, n, r), (e = Va(t)).drawImage(i.canvas, 0, 0, e.canvas.width, e.canvas.height);
				}));
			}(this, t, e, n) : za(this, t.N(), e, n);
		}
		close() {
			this.g?.close(), this.g = void 0, this.h?.close(), this.h = void 0, this.m?.close(), this.m = void 0;
		}
	};
	function Ya(t, e) {
		switch (e) {
			case 0: return t.g.find(((t) => t instanceof ImageData));
			case 1: return t.g.find(((t) => "undefined" != typeof ImageBitmap && t instanceof ImageBitmap));
			case 2: return t.g.find(((t) => "undefined" != typeof WebGLTexture && t instanceof WebGLTexture));
			default: throw Error(`Type is not supported: ${e}`);
		}
	}
	function qa(t) {
		var e = Ya(t, 0);
		if (!e) {
			e = Ja(t);
			const n = Za(t), r = new Uint8Array(t.width * t.height * 4);
			Ta(n, e, $a(t)), e.readPixels(0, 0, t.width, t.height, e.RGBA, e.UNSIGNED_BYTE, r), Aa(n), e = new ImageData(new Uint8ClampedArray(r.buffer), t.width, t.height), t.g.push(e);
		}
		return e;
	}
	function $a(t) {
		let e = Ya(t, 2);
		if (!e) {
			const n = Ja(t);
			e = Qa(t);
			const r = Ya(t, 1) || qa(t);
			n.texImage2D(n.TEXTURE_2D, 0, n.RGBA, n.RGBA, n.UNSIGNED_BYTE, r), tc(t);
		}
		return e;
	}
	function Ja(t) {
		if (!t.canvas) throw Error("Conversion to different image formats require that a canvas is passed when initializing the image.");
		return t.h || (t.h = ga(t.canvas.getContext("webgl2"), "You cannot use a canvas that is already bound to a different type of rendering context.")), t.h;
	}
	function Za(t) {
		return t.l || (t.l = new ba()), t.l;
	}
	function Qa(t) {
		const e = Ja(t);
		e.viewport(0, 0, t.width, t.height), e.activeTexture(e.TEXTURE0);
		let n = Ya(t, 2);
		return n || (n = wa(Za(t), e), t.g.push(n), t.m = !0), e.bindTexture(e.TEXTURE_2D, n), n;
	}
	function tc(t) {
		t.h.bindTexture(t.h.TEXTURE_2D, null);
	}
	function ec(t) {
		const e = Ja(t);
		return Ea(Za(t), e, !0, (() => function(t, e) {
			const n = t.canvas;
			if (n.width === t.width && n.height === t.height) return e();
			const r = n.width, i = n.height;
			return n.width = t.width, n.height = t.height, t = e(), n.width = r, n.height = i, t;
		}(t, (() => {
			if (e.bindFramebuffer(e.FRAMEBUFFER, null), e.clearColor(0, 0, 0, 0), e.clear(e.COLOR_BUFFER_BIT), e.drawArrays(e.TRIANGLE_FAN, 0, 4), !(t.canvas instanceof OffscreenCanvas)) throw Error("Conversion to ImageBitmap requires that the MediaPipe Tasks is initialized with an OffscreenCanvas");
			return t.canvas.transferToImageBitmap();
		}))));
	}
	Ka.prototype.close = Ka.prototype.close, Ka.prototype.drawConfidenceMask = Ka.prototype.wa, Ka.prototype.drawCategoryMask = Ka.prototype.va, Ka.prototype.drawBoundingBox = Ka.prototype.ua, Ka.prototype.drawConnectors = Ka.prototype.xa, Ka.prototype.drawLandmarks = Ka.prototype.ya, Ka.lerp = function(t, e, n, r, i) {
		return ja(r * (1 - (t - e) / (n - e)) + i * (1 - (n - t) / (n - e)), r, i);
	}, Ka.clamp = ja;
	var nc = class {
		constructor(t, e, n, r, i, s, o) {
			this.g = t, this.j = e, this.m = n, this.canvas = r, this.l = i, this.width = s, this.height = o, (this.j || this.m) && 0 === --rc && console.error("You seem to be creating MPImage instances without invoking .close(). This leaks resources.");
		}
		Ea() {
			return !!Ya(this, 0);
		}
		la() {
			return !!Ya(this, 1);
		}
		R() {
			return !!Ya(this, 2);
		}
		Ca() {
			return qa(this);
		}
		Ba() {
			var t = Ya(this, 1);
			return t || ($a(this), Qa(this), t = ec(this), tc(this), this.g.push(t), this.j = !0), t;
		}
		N() {
			return $a(this);
		}
		clone() {
			const t = [];
			for (const e of this.g) {
				let n;
				if (e instanceof ImageData) n = new ImageData(e.data, this.width, this.height);
				else if (e instanceof WebGLTexture) {
					const t = Ja(this), e = Za(this);
					t.activeTexture(t.TEXTURE1), n = wa(e, t), t.bindTexture(t.TEXTURE_2D, n), t.texImage2D(t.TEXTURE_2D, 0, t.RGBA, this.width, this.height, 0, t.RGBA, t.UNSIGNED_BYTE, null), t.bindTexture(t.TEXTURE_2D, null), Ta(e, t, n), Ea(e, t, !1, (() => {
						Qa(this), t.clearColor(0, 0, 0, 0), t.clear(t.COLOR_BUFFER_BIT), t.drawArrays(t.TRIANGLE_FAN, 0, 4), tc(this);
					})), Aa(e), tc(this);
				} else {
					if (!(e instanceof ImageBitmap)) throw Error(`Type is not supported: ${e}`);
					$a(this), Qa(this), n = ec(this), tc(this);
				}
				t.push(n);
			}
			return new nc(t, this.la(), this.R(), this.canvas, this.l, this.width, this.height);
		}
		close() {
			this.j && Ya(this, 1).close(), this.m && Ja(this).deleteTexture(Ya(this, 2)), rc = -1;
		}
	};
	nc.prototype.close = nc.prototype.close, nc.prototype.clone = nc.prototype.clone, nc.prototype.getAsWebGLTexture = nc.prototype.N, nc.prototype.getAsImageBitmap = nc.prototype.Ba, nc.prototype.getAsImageData = nc.prototype.Ca, nc.prototype.hasWebGLTexture = nc.prototype.R, nc.prototype.hasImageBitmap = nc.prototype.la, nc.prototype.hasImageData = nc.prototype.Ea;
	var rc = 250;
	function ic(...t) {
		return t.map((([t, e]) => ({
			start: t,
			end: e
		})));
	}
	var sc = function(t) {
		return class extends t {
			Ja() {
				this.i._registerModelResourcesGraphService();
			}
		};
	}((oc = class {
		constructor(t, e) {
			this.l = !0, this.i = t, this.g = null, this.h = 0, this.m = "function" == typeof this.i._addIntToInputStream, void 0 !== e ? this.i.canvas = e : Qo() ? this.i.canvas = new OffscreenCanvas(1, 1) : (console.warn("OffscreenCanvas not supported and GraphRunner constructor glCanvas parameter is undefined. Creating backup canvas."), this.i.canvas = document.createElement("canvas"));
		}
		async initializeGraph(t) {
			const e = await (await fetch(t)).arrayBuffer();
			t = !(t.endsWith(".pbtxt") || t.endsWith(".textproto")), this.setGraph(new Uint8Array(e), t);
		}
		setGraphFromString(t) {
			this.setGraph(new TextEncoder().encode(t), !1);
		}
		setGraph(t, e) {
			const n = t.length, r = this.i._malloc(n);
			this.i.HEAPU8.set(t, r), e ? this.i._changeBinaryGraph(n, r) : this.i._changeTextGraph(n, r), this.i._free(r);
		}
		configureAudio(t, e, n, r, i) {
			this.i._configureAudio || console.warn("Attempting to use configureAudio without support for input audio. Is build dep \":gl_graph_runner_audio\" missing?"), na(this, r || "input_audio", ((r) => {
				na(this, i = i || "audio_header", ((i) => {
					this.i._configureAudio(r, i, t, e ?? 0, n);
				}));
			}));
		}
		setAutoResizeCanvas(t) {
			this.l = t;
		}
		setAutoRenderToScreen(t) {
			this.i._setAutoRenderToScreen(t);
		}
		setGpuBufferVerticalFlip(t) {
			this.i.gpuOriginForWebTexturesIsBottomLeft = t;
		}
		ca(t) {
			sa(this, "__graph_config__", ((e) => {
				t(e);
			})), na(this, "__graph_config__", ((t) => {
				this.i._getGraphConfig(t, void 0);
			})), delete this.i.simpleListeners.__graph_config__;
		}
		attachErrorListener(t) {
			this.i.errorListener = t;
		}
		attachEmptyPacketListener(t, e) {
			this.i.emptyPacketListeners = this.i.emptyPacketListeners || {}, this.i.emptyPacketListeners[t] = e;
		}
		addAudioToStream(t, e, n) {
			this.addAudioToStreamWithShape(t, 0, 0, e, n);
		}
		addAudioToStreamWithShape(t, e, n, r, i) {
			const s = 4 * t.length;
			this.h !== s && (this.g && this.i._free(this.g), this.g = this.i._malloc(s), this.h = s), this.i.HEAPF32.set(t, this.g / 4), na(this, r, ((t) => {
				this.i._addAudioToInputStream(this.g, e, n, t, i);
			}));
		}
		addGpuBufferToStream(t, e, n) {
			na(this, e, ((e) => {
				const [r, i] = ra(this, t, e);
				this.i._addBoundTextureToStream(e, r, i, n);
			}));
		}
		addBoolToStream(t, e, n) {
			na(this, e, ((e) => {
				this.i._addBoolToInputStream(t, e, n);
			}));
		}
		addDoubleToStream(t, e, n) {
			na(this, e, ((e) => {
				this.i._addDoubleToInputStream(t, e, n);
			}));
		}
		addFloatToStream(t, e, n) {
			na(this, e, ((e) => {
				this.i._addFloatToInputStream(t, e, n);
			}));
		}
		addIntToStream(t, e, n) {
			na(this, e, ((e) => {
				this.i._addIntToInputStream(t, e, n);
			}));
		}
		addUintToStream(t, e, n) {
			na(this, e, ((e) => {
				this.i._addUintToInputStream(t, e, n);
			}));
		}
		addStringToStream(t, e, n) {
			na(this, e, ((e) => {
				na(this, t, ((t) => {
					this.i._addStringToInputStream(t, e, n);
				}));
			}));
		}
		addStringRecordToStream(t, e, n) {
			na(this, e, ((e) => {
				ia(this, Object.keys(t), ((r) => {
					ia(this, Object.values(t), ((i) => {
						this.i._addFlatHashMapToInputStream(r, i, Object.keys(t).length, e, n);
					}));
				}));
			}));
		}
		addProtoToStream(t, e, n, r) {
			na(this, n, ((n) => {
				na(this, e, ((e) => {
					const i = this.i._malloc(t.length);
					this.i.HEAPU8.set(t, i), this.i._addProtoToInputStream(i, t.length, e, n, r), this.i._free(i);
				}));
			}));
		}
		addEmptyPacketToStream(t, e) {
			na(this, t, ((t) => {
				this.i._addEmptyPacketToInputStream(t, e);
			}));
		}
		addBoolVectorToStream(t, e, n) {
			na(this, e, ((e) => {
				const r = this.i._allocateBoolVector(t.length);
				if (!r) throw Error("Unable to allocate new bool vector on heap.");
				for (const e of t) this.i._addBoolVectorEntry(r, e);
				this.i._addBoolVectorToInputStream(r, e, n);
			}));
		}
		addDoubleVectorToStream(t, e, n) {
			na(this, e, ((e) => {
				const r = this.i._allocateDoubleVector(t.length);
				if (!r) throw Error("Unable to allocate new double vector on heap.");
				for (const e of t) this.i._addDoubleVectorEntry(r, e);
				this.i._addDoubleVectorToInputStream(r, e, n);
			}));
		}
		addFloatVectorToStream(t, e, n) {
			na(this, e, ((e) => {
				const r = this.i._allocateFloatVector(t.length);
				if (!r) throw Error("Unable to allocate new float vector on heap.");
				for (const e of t) this.i._addFloatVectorEntry(r, e);
				this.i._addFloatVectorToInputStream(r, e, n);
			}));
		}
		addIntVectorToStream(t, e, n) {
			na(this, e, ((e) => {
				const r = this.i._allocateIntVector(t.length);
				if (!r) throw Error("Unable to allocate new int vector on heap.");
				for (const e of t) this.i._addIntVectorEntry(r, e);
				this.i._addIntVectorToInputStream(r, e, n);
			}));
		}
		addUintVectorToStream(t, e, n) {
			na(this, e, ((e) => {
				const r = this.i._allocateUintVector(t.length);
				if (!r) throw Error("Unable to allocate new unsigned int vector on heap.");
				for (const e of t) this.i._addUintVectorEntry(r, e);
				this.i._addUintVectorToInputStream(r, e, n);
			}));
		}
		addStringVectorToStream(t, e, n) {
			na(this, e, ((e) => {
				const r = this.i._allocateStringVector(t.length);
				if (!r) throw Error("Unable to allocate new string vector on heap.");
				for (const e of t) na(this, e, ((t) => {
					this.i._addStringVectorEntry(r, t);
				}));
				this.i._addStringVectorToInputStream(r, e, n);
			}));
		}
		addBoolToInputSidePacket(t, e) {
			na(this, e, ((e) => {
				this.i._addBoolToInputSidePacket(t, e);
			}));
		}
		addDoubleToInputSidePacket(t, e) {
			na(this, e, ((e) => {
				this.i._addDoubleToInputSidePacket(t, e);
			}));
		}
		addFloatToInputSidePacket(t, e) {
			na(this, e, ((e) => {
				this.i._addFloatToInputSidePacket(t, e);
			}));
		}
		addIntToInputSidePacket(t, e) {
			na(this, e, ((e) => {
				this.i._addIntToInputSidePacket(t, e);
			}));
		}
		addUintToInputSidePacket(t, e) {
			na(this, e, ((e) => {
				this.i._addUintToInputSidePacket(t, e);
			}));
		}
		addStringToInputSidePacket(t, e) {
			na(this, e, ((e) => {
				na(this, t, ((t) => {
					this.i._addStringToInputSidePacket(t, e);
				}));
			}));
		}
		addProtoToInputSidePacket(t, e, n) {
			na(this, n, ((n) => {
				na(this, e, ((e) => {
					const r = this.i._malloc(t.length);
					this.i.HEAPU8.set(t, r), this.i._addProtoToInputSidePacket(r, t.length, e, n), this.i._free(r);
				}));
			}));
		}
		addBoolVectorToInputSidePacket(t, e) {
			na(this, e, ((e) => {
				const n = this.i._allocateBoolVector(t.length);
				if (!n) throw Error("Unable to allocate new bool vector on heap.");
				for (const e of t) this.i._addBoolVectorEntry(n, e);
				this.i._addBoolVectorToInputSidePacket(n, e);
			}));
		}
		addDoubleVectorToInputSidePacket(t, e) {
			na(this, e, ((e) => {
				const n = this.i._allocateDoubleVector(t.length);
				if (!n) throw Error("Unable to allocate new double vector on heap.");
				for (const e of t) this.i._addDoubleVectorEntry(n, e);
				this.i._addDoubleVectorToInputSidePacket(n, e);
			}));
		}
		addFloatVectorToInputSidePacket(t, e) {
			na(this, e, ((e) => {
				const n = this.i._allocateFloatVector(t.length);
				if (!n) throw Error("Unable to allocate new float vector on heap.");
				for (const e of t) this.i._addFloatVectorEntry(n, e);
				this.i._addFloatVectorToInputSidePacket(n, e);
			}));
		}
		addIntVectorToInputSidePacket(t, e) {
			na(this, e, ((e) => {
				const n = this.i._allocateIntVector(t.length);
				if (!n) throw Error("Unable to allocate new int vector on heap.");
				for (const e of t) this.i._addIntVectorEntry(n, e);
				this.i._addIntVectorToInputSidePacket(n, e);
			}));
		}
		addUintVectorToInputSidePacket(t, e) {
			na(this, e, ((e) => {
				const n = this.i._allocateUintVector(t.length);
				if (!n) throw Error("Unable to allocate new unsigned int vector on heap.");
				for (const e of t) this.i._addUintVectorEntry(n, e);
				this.i._addUintVectorToInputSidePacket(n, e);
			}));
		}
		addStringVectorToInputSidePacket(t, e) {
			na(this, e, ((e) => {
				const n = this.i._allocateStringVector(t.length);
				if (!n) throw Error("Unable to allocate new string vector on heap.");
				for (const e of t) na(this, e, ((t) => {
					this.i._addStringVectorEntry(n, t);
				}));
				this.i._addStringVectorToInputSidePacket(n, e);
			}));
		}
		attachBoolListener(t, e) {
			sa(this, t, e), na(this, t, ((t) => {
				this.i._attachBoolListener(t);
			}));
		}
		attachBoolVectorListener(t, e) {
			oa(this, t, e), na(this, t, ((t) => {
				this.i._attachBoolVectorListener(t);
			}));
		}
		attachIntListener(t, e) {
			sa(this, t, e), na(this, t, ((t) => {
				this.i._attachIntListener(t);
			}));
		}
		attachIntVectorListener(t, e) {
			oa(this, t, e), na(this, t, ((t) => {
				this.i._attachIntVectorListener(t);
			}));
		}
		attachUintListener(t, e) {
			sa(this, t, e), na(this, t, ((t) => {
				this.i._attachUintListener(t);
			}));
		}
		attachUintVectorListener(t, e) {
			oa(this, t, e), na(this, t, ((t) => {
				this.i._attachUintVectorListener(t);
			}));
		}
		attachDoubleListener(t, e) {
			sa(this, t, e), na(this, t, ((t) => {
				this.i._attachDoubleListener(t);
			}));
		}
		attachDoubleVectorListener(t, e) {
			oa(this, t, e), na(this, t, ((t) => {
				this.i._attachDoubleVectorListener(t);
			}));
		}
		attachFloatListener(t, e) {
			sa(this, t, e), na(this, t, ((t) => {
				this.i._attachFloatListener(t);
			}));
		}
		attachFloatVectorListener(t, e) {
			oa(this, t, e), na(this, t, ((t) => {
				this.i._attachFloatVectorListener(t);
			}));
		}
		attachStringListener(t, e) {
			sa(this, t, e), na(this, t, ((t) => {
				this.i._attachStringListener(t);
			}));
		}
		attachStringVectorListener(t, e) {
			oa(this, t, e), na(this, t, ((t) => {
				this.i._attachStringVectorListener(t);
			}));
		}
		attachProtoListener(t, e, n) {
			sa(this, t, e), na(this, t, ((t) => {
				this.i._attachProtoListener(t, n || !1);
			}));
		}
		attachProtoVectorListener(t, e, n) {
			oa(this, t, e), na(this, t, ((t) => {
				this.i._attachProtoVectorListener(t, n || !1);
			}));
		}
		attachAudioListener(t, e, n) {
			this.i._attachAudioListener || console.warn("Attempting to use attachAudioListener without support for output audio. Is build dep \":gl_graph_runner_audio_out\" missing?"), sa(this, t, ((t, n) => {
				t = new Float32Array(t.buffer, t.byteOffset, t.length / 4), e(t, n);
			})), na(this, t, ((t) => {
				this.i._attachAudioListener(t, n || !1);
			}));
		}
		finishProcessing() {
			this.i._waitUntilIdle();
		}
		closeGraph() {
			this.i._closeGraph(), this.i.simpleListeners = void 0, this.i.emptyPacketListeners = void 0;
		}
	}, class extends oc {
		get ga() {
			return this.i;
		}
		pa(t, e, n) {
			na(this, e, ((e) => {
				const [r, i] = ra(this, t, e);
				this.ga._addBoundTextureAsImageToStream(e, r, i, n);
			}));
		}
		Z(t, e) {
			sa(this, t, e), na(this, t, ((t) => {
				this.ga._attachImageListener(t);
			}));
		}
		aa(t, e) {
			oa(this, t, e), na(this, t, ((t) => {
				this.ga._attachImageVectorListener(t);
			}));
		}
	}));
	var oc, ac = class extends sc {};
	async function cc(t, e, n) {
		return async function(t, e, n, r) {
			return aa(t, e, n, r);
		}(t, n.canvas ?? (Qo() ? void 0 : document.createElement("canvas")), e, n);
	}
	function hc(t, e, n, r) {
		if (t.U) {
			const s = new Ls();
			if (n?.regionOfInterest) {
				if (!t.oa) throw Error("This task doesn't support region-of-interest.");
				var i = n.regionOfInterest;
				if (i.left >= i.right || i.top >= i.bottom) throw Error("Expected RectF with left < right and top < bottom.");
				if (i.left < 0 || i.top < 0 || i.right > 1 || i.bottom > 1) throw Error("Expected RectF values to be in [0,1].");
				Ln(s, 1, (i.left + i.right) / 2), Ln(s, 2, (i.top + i.bottom) / 2), Ln(s, 4, i.right - i.left), Ln(s, 3, i.bottom - i.top);
			} else Ln(s, 1, .5), Ln(s, 2, .5), Ln(s, 4, 1), Ln(s, 3, 1);
			if (n?.rotationDegrees) {
				if (n?.rotationDegrees % 90 != 0) throw Error("Expected rotation to be a multiple of 90°.");
				if (Ln(s, 5, -Math.PI * n.rotationDegrees / 180), n?.rotationDegrees % 180 != 0) {
					const [t, r] = ea(e);
					n = Sn(s, 3) * r / t, i = Sn(s, 4) * t / r, Ln(s, 4, n), Ln(s, 3, i);
				}
			}
			t.g.addProtoToStream(s.g(), "mediapipe.NormalizedRect", t.U, r);
		}
		t.g.pa(e, t.X, r ?? performance.now()), t.finishProcessing();
	}
	function uc(t, e, n) {
		if (t.baseOptions?.g()) throw Error("Task is not initialized with image mode. 'runningMode' must be set to 'IMAGE'.");
		hc(t, e, n, t.C + 1);
	}
	function lc(t, e, n, r) {
		if (!t.baseOptions?.g()) throw Error("Task is not initialized with video mode. 'runningMode' must be set to 'VIDEO'.");
		hc(t, e, n, r);
	}
	function fc(t, e, n, r) {
		var i = e.data;
		const s = e.width, o = s * (e = e.height);
		if ((i instanceof Uint8Array || i instanceof Float32Array) && i.length !== o) throw Error("Unsupported channel count: " + i.length / o);
		return t = new Na([i], n, !1, t.g.i.canvas, t.P, s, e), r ? t.clone() : t;
	}
	var dc = class extends pa {
		constructor(t, e, n, r) {
			super(t), this.g = t, this.X = e, this.U = n, this.oa = r, this.P = new ba();
		}
		l(t, e = !0) {
			if ("runningMode" in t && Ze(this.baseOptions, 2, Jt(!!t.runningMode && "IMAGE" !== t.runningMode)), void 0 !== t.canvas && this.g.i.canvas !== t.canvas) throw Error("You must create a new task to reset the canvas.");
			return super.l(t, e);
		}
		close() {
			this.P.close(), super.close();
		}
	};
	dc.prototype.close = dc.prototype.close;
	var pc = class extends dc {
		constructor(t, e) {
			super(new ac(t, e), "image_in", "norm_rect_in", !1), this.j = { detections: [] }, wn(t = this.h = new zs(), 0, 1, e = new Xs()), Ln(this.h, 2, .5), Ln(this.h, 3, .3);
		}
		get baseOptions() {
			return yn(this.h, Xs, 1);
		}
		set baseOptions(t) {
			wn(this.h, 0, 1, t);
		}
		o(t) {
			return "minDetectionConfidence" in t && Ln(this.h, 2, t.minDetectionConfidence ?? .5), "minSuppressionThreshold" in t && Ln(this.h, 3, t.minSuppressionThreshold ?? .3), this.l(t);
		}
		F(t, e) {
			return this.j = { detections: [] }, uc(this, t, e), this.j;
		}
		G(t, e, n) {
			return this.j = { detections: [] }, lc(this, t, n, e), this.j;
		}
		m() {
			var t = new ls();
			hs(t, "image_in"), hs(t, "norm_rect_in"), us(t, "detections");
			const e = new Qi();
			xr(e, Ys, this.h);
			const n = new is();
			Rn(n, 2, "mediapipe.tasks.vision.face_detector.FaceDetectorGraph"), ns(n, "IMAGE:image_in"), ns(n, "NORM_RECT:norm_rect_in"), rs(n, "DETECTIONS:detections"), n.o(e), cs(t, n), this.g.attachProtoVectorListener("detections", ((t, e) => {
				for (const e of t) t = ws(e), this.j.detections.push(Xo(t));
				ua(this, e);
			})), this.g.attachEmptyPacketListener("detections", ((t) => {
				ua(this, t);
			})), t = t.g(), this.setGraph(new Uint8Array(t), !0);
		}
	};
	pc.prototype.detectForVideo = pc.prototype.G, pc.prototype.detect = pc.prototype.F, pc.prototype.setOptions = pc.prototype.o, pc.createFromModelPath = async function(t, e) {
		return cc(pc, t, { baseOptions: { modelAssetPath: e } });
	}, pc.createFromModelBuffer = function(t, e) {
		return cc(pc, t, { baseOptions: { modelAssetBuffer: e } });
	}, pc.createFromOptions = function(t, e) {
		return cc(pc, t, e);
	};
	var gc = ic([61, 146], [146, 91], [91, 181], [181, 84], [84, 17], [17, 314], [314, 405], [405, 321], [321, 375], [375, 291], [61, 185], [185, 40], [40, 39], [39, 37], [37, 0], [0, 267], [267, 269], [269, 270], [270, 409], [409, 291], [78, 95], [95, 88], [88, 178], [178, 87], [87, 14], [14, 317], [317, 402], [402, 318], [318, 324], [324, 308], [78, 191], [191, 80], [80, 81], [81, 82], [82, 13], [13, 312], [312, 311], [311, 310], [310, 415], [415, 308]), mc = ic([263, 249], [249, 390], [390, 373], [373, 374], [374, 380], [380, 381], [381, 382], [382, 362], [263, 466], [466, 388], [388, 387], [387, 386], [386, 385], [385, 384], [384, 398], [398, 362]), yc = ic([276, 283], [283, 282], [282, 295], [295, 285], [300, 293], [293, 334], [334, 296], [296, 336]), _c = ic([474, 475], [475, 476], [476, 477], [477, 474]), vc = ic([33, 7], [7, 163], [163, 144], [144, 145], [145, 153], [153, 154], [154, 155], [155, 133], [33, 246], [246, 161], [161, 160], [160, 159], [159, 158], [158, 157], [157, 173], [173, 133]), Ec = ic([46, 53], [53, 52], [52, 65], [65, 55], [70, 63], [63, 105], [105, 66], [66, 107]), wc = ic([469, 470], [470, 471], [471, 472], [472, 469]), Tc = ic([10, 338], [338, 297], [297, 332], [332, 284], [284, 251], [251, 389], [389, 356], [356, 454], [454, 323], [323, 361], [361, 288], [288, 397], [397, 365], [365, 379], [379, 378], [378, 400], [400, 377], [377, 152], [152, 148], [148, 176], [176, 149], [149, 150], [150, 136], [136, 172], [172, 58], [58, 132], [132, 93], [93, 234], [234, 127], [127, 162], [162, 21], [21, 54], [54, 103], [103, 67], [67, 109], [109, 10]), Ac = [
		...gc,
		...mc,
		...yc,
		...vc,
		...Ec,
		...Tc
	], bc = ic([127, 34], [34, 139], [139, 127], [11, 0], [0, 37], [37, 11], [232, 231], [231, 120], [120, 232], [72, 37], [37, 39], [39, 72], [128, 121], [121, 47], [47, 128], [232, 121], [121, 128], [128, 232], [104, 69], [69, 67], [67, 104], [175, 171], [171, 148], [148, 175], [118, 50], [50, 101], [101, 118], [73, 39], [39, 40], [40, 73], [9, 151], [151, 108], [108, 9], [48, 115], [115, 131], [131, 48], [194, 204], [204, 211], [211, 194], [74, 40], [40, 185], [185, 74], [80, 42], [42, 183], [183, 80], [40, 92], [92, 186], [186, 40], [230, 229], [229, 118], [118, 230], [202, 212], [212, 214], [214, 202], [83, 18], [18, 17], [17, 83], [76, 61], [61, 146], [146, 76], [160, 29], [29, 30], [30, 160], [56, 157], [157, 173], [173, 56], [106, 204], [204, 194], [194, 106], [135, 214], [214, 192], [192, 135], [203, 165], [165, 98], [98, 203], [21, 71], [71, 68], [68, 21], [51, 45], [45, 4], [4, 51], [144, 24], [24, 23], [23, 144], [77, 146], [146, 91], [91, 77], [205, 50], [50, 187], [187, 205], [201, 200], [200, 18], [18, 201], [91, 106], [106, 182], [182, 91], [90, 91], [91, 181], [181, 90], [85, 84], [84, 17], [17, 85], [206, 203], [203, 36], [36, 206], [148, 171], [171, 140], [140, 148], [92, 40], [40, 39], [39, 92], [193, 189], [189, 244], [244, 193], [159, 158], [158, 28], [28, 159], [247, 246], [246, 161], [161, 247], [236, 3], [3, 196], [196, 236], [54, 68], [68, 104], [104, 54], [193, 168], [168, 8], [8, 193], [117, 228], [228, 31], [31, 117], [189, 193], [193, 55], [55, 189], [98, 97], [97, 99], [99, 98], [126, 47], [47, 100], [100, 126], [166, 79], [79, 218], [218, 166], [155, 154], [154, 26], [26, 155], [209, 49], [49, 131], [131, 209], [135, 136], [136, 150], [150, 135], [47, 126], [126, 217], [217, 47], [223, 52], [52, 53], [53, 223], [45, 51], [51, 134], [134, 45], [211, 170], [170, 140], [140, 211], [67, 69], [69, 108], [108, 67], [43, 106], [106, 91], [91, 43], [230, 119], [119, 120], [120, 230], [226, 130], [130, 247], [247, 226], [63, 53], [53, 52], [52, 63], [238, 20], [20, 242], [242, 238], [46, 70], [70, 156], [156, 46], [78, 62], [62, 96], [96, 78], [46, 53], [53, 63], [63, 46], [143, 34], [34, 227], [227, 143], [123, 117], [117, 111], [111, 123], [44, 125], [125, 19], [19, 44], [236, 134], [134, 51], [51, 236], [216, 206], [206, 205], [205, 216], [154, 153], [153, 22], [22, 154], [39, 37], [37, 167], [167, 39], [200, 201], [201, 208], [208, 200], [36, 142], [142, 100], [100, 36], [57, 212], [212, 202], [202, 57], [20, 60], [60, 99], [99, 20], [28, 158], [158, 157], [157, 28], [35, 226], [226, 113], [113, 35], [160, 159], [159, 27], [27, 160], [204, 202], [202, 210], [210, 204], [113, 225], [225, 46], [46, 113], [43, 202], [202, 204], [204, 43], [62, 76], [76, 77], [77, 62], [137, 123], [123, 116], [116, 137], [41, 38], [38, 72], [72, 41], [203, 129], [129, 142], [142, 203], [64, 98], [98, 240], [240, 64], [49, 102], [102, 64], [64, 49], [41, 73], [73, 74], [74, 41], [212, 216], [216, 207], [207, 212], [42, 74], [74, 184], [184, 42], [169, 170], [170, 211], [211, 169], [170, 149], [149, 176], [176, 170], [105, 66], [66, 69], [69, 105], [122, 6], [6, 168], [168, 122], [123, 147], [147, 187], [187, 123], [96, 77], [77, 90], [90, 96], [65, 55], [55, 107], [107, 65], [89, 90], [90, 180], [180, 89], [101, 100], [100, 120], [120, 101], [63, 105], [105, 104], [104, 63], [93, 137], [137, 227], [227, 93], [15, 86], [86, 85], [85, 15], [129, 102], [102, 49], [49, 129], [14, 87], [87, 86], [86, 14], [55, 8], [8, 9], [9, 55], [100, 47], [47, 121], [121, 100], [145, 23], [23, 22], [22, 145], [88, 89], [89, 179], [179, 88], [6, 122], [122, 196], [196, 6], [88, 95], [95, 96], [96, 88], [138, 172], [172, 136], [136, 138], [215, 58], [58, 172], [172, 215], [115, 48], [48, 219], [219, 115], [42, 80], [80, 81], [81, 42], [195, 3], [3, 51], [51, 195], [43, 146], [146, 61], [61, 43], [171, 175], [175, 199], [199, 171], [81, 82], [82, 38], [38, 81], [53, 46], [46, 225], [225, 53], [144, 163], [163, 110], [110, 144], [52, 65], [65, 66], [66, 52], [229, 228], [228, 117], [117, 229], [34, 127], [127, 234], [234, 34], [107, 108], [108, 69], [69, 107], [109, 108], [108, 151], [151, 109], [48, 64], [64, 235], [235, 48], [62, 78], [78, 191], [191, 62], [129, 209], [209, 126], [126, 129], [111, 35], [35, 143], [143, 111], [117, 123], [123, 50], [50, 117], [222, 65], [65, 52], [52, 222], [19, 125], [125, 141], [141, 19], [221, 55], [55, 65], [65, 221], [3, 195], [195, 197], [197, 3], [25, 7], [7, 33], [33, 25], [220, 237], [237, 44], [44, 220], [70, 71], [71, 139], [139, 70], [122, 193], [193, 245], [245, 122], [247, 130], [130, 33], [33, 247], [71, 21], [21, 162], [162, 71], [170, 169], [169, 150], [150, 170], [188, 174], [174, 196], [196, 188], [216, 186], [186, 92], [92, 216], [2, 97], [97, 167], [167, 2], [141, 125], [125, 241], [241, 141], [164, 167], [167, 37], [37, 164], [72, 38], [38, 12], [12, 72], [38, 82], [82, 13], [13, 38], [63, 68], [68, 71], [71, 63], [226, 35], [35, 111], [111, 226], [101, 50], [50, 205], [205, 101], [206, 92], [92, 165], [165, 206], [209, 198], [198, 217], [217, 209], [165, 167], [167, 97], [97, 165], [220, 115], [115, 218], [218, 220], [133, 112], [112, 243], [243, 133], [239, 238], [238, 241], [241, 239], [214, 135], [135, 169], [169, 214], [190, 173], [173, 133], [133, 190], [171, 208], [208, 32], [32, 171], [125, 44], [44, 237], [237, 125], [86, 87], [87, 178], [178, 86], [85, 86], [86, 179], [179, 85], [84, 85], [85, 180], [180, 84], [83, 84], [84, 181], [181, 83], [201, 83], [83, 182], [182, 201], [137, 93], [93, 132], [132, 137], [76, 62], [62, 183], [183, 76], [61, 76], [76, 184], [184, 61], [57, 61], [61, 185], [185, 57], [212, 57], [57, 186], [186, 212], [214, 207], [207, 187], [187, 214], [34, 143], [143, 156], [156, 34], [79, 239], [239, 237], [237, 79], [123, 137], [137, 177], [177, 123], [44, 1], [1, 4], [4, 44], [201, 194], [194, 32], [32, 201], [64, 102], [102, 129], [129, 64], [213, 215], [215, 138], [138, 213], [59, 166], [166, 219], [219, 59], [242, 99], [99, 97], [97, 242], [2, 94], [94, 141], [141, 2], [75, 59], [59, 235], [235, 75], [24, 110], [110, 228], [228, 24], [25, 130], [130, 226], [226, 25], [23, 24], [24, 229], [229, 23], [22, 23], [23, 230], [230, 22], [26, 22], [22, 231], [231, 26], [112, 26], [26, 232], [232, 112], [189, 190], [190, 243], [243, 189], [221, 56], [56, 190], [190, 221], [28, 56], [56, 221], [221, 28], [27, 28], [28, 222], [222, 27], [29, 27], [27, 223], [223, 29], [30, 29], [29, 224], [224, 30], [247, 30], [30, 225], [225, 247], [238, 79], [79, 20], [20, 238], [166, 59], [59, 75], [75, 166], [60, 75], [75, 240], [240, 60], [147, 177], [177, 215], [215, 147], [20, 79], [79, 166], [166, 20], [187, 147], [147, 213], [213, 187], [112, 233], [233, 244], [244, 112], [233, 128], [128, 245], [245, 233], [128, 114], [114, 188], [188, 128], [114, 217], [217, 174], [174, 114], [131, 115], [115, 220], [220, 131], [217, 198], [198, 236], [236, 217], [198, 131], [131, 134], [134, 198], [177, 132], [132, 58], [58, 177], [143, 35], [35, 124], [124, 143], [110, 163], [163, 7], [7, 110], [228, 110], [110, 25], [25, 228], [356, 389], [389, 368], [368, 356], [11, 302], [302, 267], [267, 11], [452, 350], [350, 349], [349, 452], [302, 303], [303, 269], [269, 302], [357, 343], [343, 277], [277, 357], [452, 453], [453, 357], [357, 452], [333, 332], [332, 297], [297, 333], [175, 152], [152, 377], [377, 175], [347, 348], [348, 330], [330, 347], [303, 304], [304, 270], [270, 303], [9, 336], [336, 337], [337, 9], [278, 279], [279, 360], [360, 278], [418, 262], [262, 431], [431, 418], [304, 408], [408, 409], [409, 304], [310, 415], [415, 407], [407, 310], [270, 409], [409, 410], [410, 270], [450, 348], [348, 347], [347, 450], [422, 430], [430, 434], [434, 422], [313, 314], [314, 17], [17, 313], [306, 307], [307, 375], [375, 306], [387, 388], [388, 260], [260, 387], [286, 414], [414, 398], [398, 286], [335, 406], [406, 418], [418, 335], [364, 367], [367, 416], [416, 364], [423, 358], [358, 327], [327, 423], [251, 284], [284, 298], [298, 251], [281, 5], [5, 4], [4, 281], [373, 374], [374, 253], [253, 373], [307, 320], [320, 321], [321, 307], [425, 427], [427, 411], [411, 425], [421, 313], [313, 18], [18, 421], [321, 405], [405, 406], [406, 321], [320, 404], [404, 405], [405, 320], [315, 16], [16, 17], [17, 315], [426, 425], [425, 266], [266, 426], [377, 400], [400, 369], [369, 377], [322, 391], [391, 269], [269, 322], [417, 465], [465, 464], [464, 417], [386, 257], [257, 258], [258, 386], [466, 260], [260, 388], [388, 466], [456, 399], [399, 419], [419, 456], [284, 332], [332, 333], [333, 284], [417, 285], [285, 8], [8, 417], [346, 340], [340, 261], [261, 346], [413, 441], [441, 285], [285, 413], [327, 460], [460, 328], [328, 327], [355, 371], [371, 329], [329, 355], [392, 439], [439, 438], [438, 392], [382, 341], [341, 256], [256, 382], [429, 420], [420, 360], [360, 429], [364, 394], [394, 379], [379, 364], [277, 343], [343, 437], [437, 277], [443, 444], [444, 283], [283, 443], [275, 440], [440, 363], [363, 275], [431, 262], [262, 369], [369, 431], [297, 338], [338, 337], [337, 297], [273, 375], [375, 321], [321, 273], [450, 451], [451, 349], [349, 450], [446, 342], [342, 467], [467, 446], [293, 334], [334, 282], [282, 293], [458, 461], [461, 462], [462, 458], [276, 353], [353, 383], [383, 276], [308, 324], [324, 325], [325, 308], [276, 300], [300, 293], [293, 276], [372, 345], [345, 447], [447, 372], [352, 345], [345, 340], [340, 352], [274, 1], [1, 19], [19, 274], [456, 248], [248, 281], [281, 456], [436, 427], [427, 425], [425, 436], [381, 256], [256, 252], [252, 381], [269, 391], [391, 393], [393, 269], [200, 199], [199, 428], [428, 200], [266, 330], [330, 329], [329, 266], [287, 273], [273, 422], [422, 287], [250, 462], [462, 328], [328, 250], [258, 286], [286, 384], [384, 258], [265, 353], [353, 342], [342, 265], [387, 259], [259, 257], [257, 387], [424, 431], [431, 430], [430, 424], [342, 353], [353, 276], [276, 342], [273, 335], [335, 424], [424, 273], [292, 325], [325, 307], [307, 292], [366, 447], [447, 345], [345, 366], [271, 303], [303, 302], [302, 271], [423, 266], [266, 371], [371, 423], [294, 455], [455, 460], [460, 294], [279, 278], [278, 294], [294, 279], [271, 272], [272, 304], [304, 271], [432, 434], [434, 427], [427, 432], [272, 407], [407, 408], [408, 272], [394, 430], [430, 431], [431, 394], [395, 369], [369, 400], [400, 395], [334, 333], [333, 299], [299, 334], [351, 417], [417, 168], [168, 351], [352, 280], [280, 411], [411, 352], [325, 319], [319, 320], [320, 325], [295, 296], [296, 336], [336, 295], [319, 403], [403, 404], [404, 319], [330, 348], [348, 349], [349, 330], [293, 298], [298, 333], [333, 293], [323, 454], [454, 447], [447, 323], [15, 16], [16, 315], [315, 15], [358, 429], [429, 279], [279, 358], [14, 15], [15, 316], [316, 14], [285, 336], [336, 9], [9, 285], [329, 349], [349, 350], [350, 329], [374, 380], [380, 252], [252, 374], [318, 402], [402, 403], [403, 318], [6, 197], [197, 419], [419, 6], [318, 319], [319, 325], [325, 318], [367, 364], [364, 365], [365, 367], [435, 367], [367, 397], [397, 435], [344, 438], [438, 439], [439, 344], [272, 271], [271, 311], [311, 272], [195, 5], [5, 281], [281, 195], [273, 287], [287, 291], [291, 273], [396, 428], [428, 199], [199, 396], [311, 271], [271, 268], [268, 311], [283, 444], [444, 445], [445, 283], [373, 254], [254, 339], [339, 373], [282, 334], [334, 296], [296, 282], [449, 347], [347, 346], [346, 449], [264, 447], [447, 454], [454, 264], [336, 296], [296, 299], [299, 336], [338, 10], [10, 151], [151, 338], [278, 439], [439, 455], [455, 278], [292, 407], [407, 415], [415, 292], [358, 371], [371, 355], [355, 358], [340, 345], [345, 372], [372, 340], [346, 347], [347, 280], [280, 346], [442, 443], [443, 282], [282, 442], [19, 94], [94, 370], [370, 19], [441, 442], [442, 295], [295, 441], [248, 419], [419, 197], [197, 248], [263, 255], [255, 359], [359, 263], [440, 275], [275, 274], [274, 440], [300, 383], [383, 368], [368, 300], [351, 412], [412, 465], [465, 351], [263, 467], [467, 466], [466, 263], [301, 368], [368, 389], [389, 301], [395, 378], [378, 379], [379, 395], [412, 351], [351, 419], [419, 412], [436, 426], [426, 322], [322, 436], [2, 164], [164, 393], [393, 2], [370, 462], [462, 461], [461, 370], [164, 0], [0, 267], [267, 164], [302, 11], [11, 12], [12, 302], [268, 12], [12, 13], [13, 268], [293, 300], [300, 301], [301, 293], [446, 261], [261, 340], [340, 446], [330, 266], [266, 425], [425, 330], [426, 423], [423, 391], [391, 426], [429, 355], [355, 437], [437, 429], [391, 327], [327, 326], [326, 391], [440, 457], [457, 438], [438, 440], [341, 382], [382, 362], [362, 341], [459, 457], [457, 461], [461, 459], [434, 430], [430, 394], [394, 434], [414, 463], [463, 362], [362, 414], [396, 369], [369, 262], [262, 396], [354, 461], [461, 457], [457, 354], [316, 403], [403, 402], [402, 316], [315, 404], [404, 403], [403, 315], [314, 405], [405, 404], [404, 314], [313, 406], [406, 405], [405, 313], [421, 418], [418, 406], [406, 421], [366, 401], [401, 361], [361, 366], [306, 408], [408, 407], [407, 306], [291, 409], [409, 408], [408, 291], [287, 410], [410, 409], [409, 287], [432, 436], [436, 410], [410, 432], [434, 416], [416, 411], [411, 434], [264, 368], [368, 383], [383, 264], [309, 438], [438, 457], [457, 309], [352, 376], [376, 401], [401, 352], [274, 275], [275, 4], [4, 274], [421, 428], [428, 262], [262, 421], [294, 327], [327, 358], [358, 294], [433, 416], [416, 367], [367, 433], [289, 455], [455, 439], [439, 289], [462, 370], [370, 326], [326, 462], [2, 326], [326, 370], [370, 2], [305, 460], [460, 455], [455, 305], [254, 449], [449, 448], [448, 254], [255, 261], [261, 446], [446, 255], [253, 450], [450, 449], [449, 253], [252, 451], [451, 450], [450, 252], [256, 452], [452, 451], [451, 256], [341, 453], [453, 452], [452, 341], [413, 464], [464, 463], [463, 413], [441, 413], [413, 414], [414, 441], [258, 442], [442, 441], [441, 258], [257, 443], [443, 442], [442, 257], [259, 444], [444, 443], [443, 259], [260, 445], [445, 444], [444, 260], [467, 342], [342, 445], [445, 467], [459, 458], [458, 250], [250, 459], [289, 392], [392, 290], [290, 289], [290, 328], [328, 460], [460, 290], [376, 433], [433, 435], [435, 376], [250, 290], [290, 392], [392, 250], [411, 416], [416, 433], [433, 411], [341, 463], [463, 464], [464, 341], [453, 464], [464, 465], [465, 453], [357, 465], [465, 412], [412, 357], [343, 412], [412, 399], [399, 343], [360, 363], [363, 440], [440, 360], [437, 399], [399, 456], [456, 437], [420, 456], [456, 363], [363, 420], [401, 435], [435, 288], [288, 401], [372, 383], [383, 353], [353, 372], [339, 255], [255, 249], [249, 339], [448, 261], [261, 255], [255, 448], [133, 243], [243, 190], [190, 133], [133, 155], [155, 112], [112, 133], [33, 246], [246, 247], [247, 33], [33, 130], [130, 25], [25, 33], [398, 384], [384, 286], [286, 398], [362, 398], [398, 414], [414, 362], [362, 463], [463, 341], [341, 362], [263, 359], [359, 467], [467, 263], [263, 249], [249, 255], [255, 263], [466, 467], [467, 260], [260, 466], [75, 60], [60, 166], [166, 75], [238, 239], [239, 79], [79, 238], [162, 127], [127, 139], [139, 162], [72, 11], [11, 37], [37, 72], [121, 232], [232, 120], [120, 121], [73, 72], [72, 39], [39, 73], [114, 128], [128, 47], [47, 114], [233, 232], [232, 128], [128, 233], [103, 104], [104, 67], [67, 103], [152, 175], [175, 148], [148, 152], [119, 118], [118, 101], [101, 119], [74, 73], [73, 40], [40, 74], [107, 9], [9, 108], [108, 107], [49, 48], [48, 131], [131, 49], [32, 194], [194, 211], [211, 32], [184, 74], [74, 185], [185, 184], [191, 80], [80, 183], [183, 191], [185, 40], [40, 186], [186, 185], [119, 230], [230, 118], [118, 119], [210, 202], [202, 214], [214, 210], [84, 83], [83, 17], [17, 84], [77, 76], [76, 146], [146, 77], [161, 160], [160, 30], [30, 161], [190, 56], [56, 173], [173, 190], [182, 106], [106, 194], [194, 182], [138, 135], [135, 192], [192, 138], [129, 203], [203, 98], [98, 129], [54, 21], [21, 68], [68, 54], [5, 51], [51, 4], [4, 5], [145, 144], [144, 23], [23, 145], [90, 77], [77, 91], [91, 90], [207, 205], [205, 187], [187, 207], [83, 201], [201, 18], [18, 83], [181, 91], [91, 182], [182, 181], [180, 90], [90, 181], [181, 180], [16, 85], [85, 17], [17, 16], [205, 206], [206, 36], [36, 205], [176, 148], [148, 140], [140, 176], [165, 92], [92, 39], [39, 165], [245, 193], [193, 244], [244, 245], [27, 159], [159, 28], [28, 27], [30, 247], [247, 161], [161, 30], [174, 236], [236, 196], [196, 174], [103, 54], [54, 104], [104, 103], [55, 193], [193, 8], [8, 55], [111, 117], [117, 31], [31, 111], [221, 189], [189, 55], [55, 221], [240, 98], [98, 99], [99, 240], [142, 126], [126, 100], [100, 142], [219, 166], [166, 218], [218, 219], [112, 155], [155, 26], [26, 112], [198, 209], [209, 131], [131, 198], [169, 135], [135, 150], [150, 169], [114, 47], [47, 217], [217, 114], [224, 223], [223, 53], [53, 224], [220, 45], [45, 134], [134, 220], [32, 211], [211, 140], [140, 32], [109, 67], [67, 108], [108, 109], [146, 43], [43, 91], [91, 146], [231, 230], [230, 120], [120, 231], [113, 226], [226, 247], [247, 113], [105, 63], [63, 52], [52, 105], [241, 238], [238, 242], [242, 241], [124, 46], [46, 156], [156, 124], [95, 78], [78, 96], [96, 95], [70, 46], [46, 63], [63, 70], [116, 143], [143, 227], [227, 116], [116, 123], [123, 111], [111, 116], [1, 44], [44, 19], [19, 1], [3, 236], [236, 51], [51, 3], [207, 216], [216, 205], [205, 207], [26, 154], [154, 22], [22, 26], [165, 39], [39, 167], [167, 165], [199, 200], [200, 208], [208, 199], [101, 36], [36, 100], [100, 101], [43, 57], [57, 202], [202, 43], [242, 20], [20, 99], [99, 242], [56, 28], [28, 157], [157, 56], [124, 35], [35, 113], [113, 124], [29, 160], [160, 27], [27, 29], [211, 204], [204, 210], [210, 211], [124, 113], [113, 46], [46, 124], [106, 43], [43, 204], [204, 106], [96, 62], [62, 77], [77, 96], [227, 137], [137, 116], [116, 227], [73, 41], [41, 72], [72, 73], [36, 203], [203, 142], [142, 36], [235, 64], [64, 240], [240, 235], [48, 49], [49, 64], [64, 48], [42, 41], [41, 74], [74, 42], [214, 212], [212, 207], [207, 214], [183, 42], [42, 184], [184, 183], [210, 169], [169, 211], [211, 210], [140, 170], [170, 176], [176, 140], [104, 105], [105, 69], [69, 104], [193, 122], [122, 168], [168, 193], [50, 123], [123, 187], [187, 50], [89, 96], [96, 90], [90, 89], [66, 65], [65, 107], [107, 66], [179, 89], [89, 180], [180, 179], [119, 101], [101, 120], [120, 119], [68, 63], [63, 104], [104, 68], [234, 93], [93, 227], [227, 234], [16, 15], [15, 85], [85, 16], [209, 129], [129, 49], [49, 209], [15, 14], [14, 86], [86, 15], [107, 55], [55, 9], [9, 107], [120, 100], [100, 121], [121, 120], [153, 145], [145, 22], [22, 153], [178, 88], [88, 179], [179, 178], [197, 6], [6, 196], [196, 197], [89, 88], [88, 96], [96, 89], [135, 138], [138, 136], [136, 135], [138, 215], [215, 172], [172, 138], [218, 115], [115, 219], [219, 218], [41, 42], [42, 81], [81, 41], [5, 195], [195, 51], [51, 5], [57, 43], [43, 61], [61, 57], [208, 171], [171, 199], [199, 208], [41, 81], [81, 38], [38, 41], [224, 53], [53, 225], [225, 224], [24, 144], [144, 110], [110, 24], [105, 52], [52, 66], [66, 105], [118, 229], [229, 117], [117, 118], [227, 34], [34, 234], [234, 227], [66, 107], [107, 69], [69, 66], [10, 109], [109, 151], [151, 10], [219, 48], [48, 235], [235, 219], [183, 62], [62, 191], [191, 183], [142, 129], [129, 126], [126, 142], [116, 111], [111, 143], [143, 116], [118, 117], [117, 50], [50, 118], [223, 222], [222, 52], [52, 223], [94, 19], [19, 141], [141, 94], [222, 221], [221, 65], [65, 222], [196, 3], [3, 197], [197, 196], [45, 220], [220, 44], [44, 45], [156, 70], [70, 139], [139, 156], [188, 122], [122, 245], [245, 188], [139, 71], [71, 162], [162, 139], [149, 170], [170, 150], [150, 149], [122, 188], [188, 196], [196, 122], [206, 216], [216, 92], [92, 206], [164, 2], [2, 167], [167, 164], [242, 141], [141, 241], [241, 242], [0, 164], [164, 37], [37, 0], [11, 72], [72, 12], [12, 11], [12, 38], [38, 13], [13, 12], [70, 63], [63, 71], [71, 70], [31, 226], [226, 111], [111, 31], [36, 101], [101, 205], [205, 36], [203, 206], [206, 165], [165, 203], [126, 209], [209, 217], [217, 126], [98, 165], [165, 97], [97, 98], [237, 220], [220, 218], [218, 237], [237, 239], [239, 241], [241, 237], [210, 214], [214, 169], [169, 210], [140, 171], [171, 32], [32, 140], [241, 125], [125, 237], [237, 241], [179, 86], [86, 178], [178, 179], [180, 85], [85, 179], [179, 180], [181, 84], [84, 180], [180, 181], [182, 83], [83, 181], [181, 182], [194, 201], [201, 182], [182, 194], [177, 137], [137, 132], [132, 177], [184, 76], [76, 183], [183, 184], [185, 61], [61, 184], [184, 185], [186, 57], [57, 185], [185, 186], [216, 212], [212, 186], [186, 216], [192, 214], [214, 187], [187, 192], [139, 34], [34, 156], [156, 139], [218, 79], [79, 237], [237, 218], [147, 123], [123, 177], [177, 147], [45, 44], [44, 4], [4, 45], [208, 201], [201, 32], [32, 208], [98, 64], [64, 129], [129, 98], [192, 213], [213, 138], [138, 192], [235, 59], [59, 219], [219, 235], [141, 242], [242, 97], [97, 141], [97, 2], [2, 141], [141, 97], [240, 75], [75, 235], [235, 240], [229, 24], [24, 228], [228, 229], [31, 25], [25, 226], [226, 31], [230, 23], [23, 229], [229, 230], [231, 22], [22, 230], [230, 231], [232, 26], [26, 231], [231, 232], [233, 112], [112, 232], [232, 233], [244, 189], [189, 243], [243, 244], [189, 221], [221, 190], [190, 189], [222, 28], [28, 221], [221, 222], [223, 27], [27, 222], [222, 223], [224, 29], [29, 223], [223, 224], [225, 30], [30, 224], [224, 225], [113, 247], [247, 225], [225, 113], [99, 60], [60, 240], [240, 99], [213, 147], [147, 215], [215, 213], [60, 20], [20, 166], [166, 60], [192, 187], [187, 213], [213, 192], [243, 112], [112, 244], [244, 243], [244, 233], [233, 245], [245, 244], [245, 128], [128, 188], [188, 245], [188, 114], [114, 174], [174, 188], [134, 131], [131, 220], [220, 134], [174, 217], [217, 236], [236, 174], [236, 198], [198, 134], [134, 236], [215, 177], [177, 58], [58, 215], [156, 143], [143, 124], [124, 156], [25, 110], [110, 7], [7, 25], [31, 228], [228, 25], [25, 31], [264, 356], [356, 368], [368, 264], [0, 11], [11, 267], [267, 0], [451, 452], [452, 349], [349, 451], [267, 302], [302, 269], [269, 267], [350, 357], [357, 277], [277, 350], [350, 452], [452, 357], [357, 350], [299, 333], [333, 297], [297, 299], [396, 175], [175, 377], [377, 396], [280, 347], [347, 330], [330, 280], [269, 303], [303, 270], [270, 269], [151, 9], [9, 337], [337, 151], [344, 278], [278, 360], [360, 344], [424, 418], [418, 431], [431, 424], [270, 304], [304, 409], [409, 270], [272, 310], [310, 407], [407, 272], [322, 270], [270, 410], [410, 322], [449, 450], [450, 347], [347, 449], [432, 422], [422, 434], [434, 432], [18, 313], [313, 17], [17, 18], [291, 306], [306, 375], [375, 291], [259, 387], [387, 260], [260, 259], [424, 335], [335, 418], [418, 424], [434, 364], [364, 416], [416, 434], [391, 423], [423, 327], [327, 391], [301, 251], [251, 298], [298, 301], [275, 281], [281, 4], [4, 275], [254, 373], [373, 253], [253, 254], [375, 307], [307, 321], [321, 375], [280, 425], [425, 411], [411, 280], [200, 421], [421, 18], [18, 200], [335, 321], [321, 406], [406, 335], [321, 320], [320, 405], [405, 321], [314, 315], [315, 17], [17, 314], [423, 426], [426, 266], [266, 423], [396, 377], [377, 369], [369, 396], [270, 322], [322, 269], [269, 270], [413, 417], [417, 464], [464, 413], [385, 386], [386, 258], [258, 385], [248, 456], [456, 419], [419, 248], [298, 284], [284, 333], [333, 298], [168, 417], [417, 8], [8, 168], [448, 346], [346, 261], [261, 448], [417, 413], [413, 285], [285, 417], [326, 327], [327, 328], [328, 326], [277, 355], [355, 329], [329, 277], [309, 392], [392, 438], [438, 309], [381, 382], [382, 256], [256, 381], [279, 429], [429, 360], [360, 279], [365, 364], [364, 379], [379, 365], [355, 277], [277, 437], [437, 355], [282, 443], [443, 283], [283, 282], [281, 275], [275, 363], [363, 281], [395, 431], [431, 369], [369, 395], [299, 297], [297, 337], [337, 299], [335, 273], [273, 321], [321, 335], [348, 450], [450, 349], [349, 348], [359, 446], [446, 467], [467, 359], [283, 293], [293, 282], [282, 283], [250, 458], [458, 462], [462, 250], [300, 276], [276, 383], [383, 300], [292, 308], [308, 325], [325, 292], [283, 276], [276, 293], [293, 283], [264, 372], [372, 447], [447, 264], [346, 352], [352, 340], [340, 346], [354, 274], [274, 19], [19, 354], [363, 456], [456, 281], [281, 363], [426, 436], [436, 425], [425, 426], [380, 381], [381, 252], [252, 380], [267, 269], [269, 393], [393, 267], [421, 200], [200, 428], [428, 421], [371, 266], [266, 329], [329, 371], [432, 287], [287, 422], [422, 432], [290, 250], [250, 328], [328, 290], [385, 258], [258, 384], [384, 385], [446, 265], [265, 342], [342, 446], [386, 387], [387, 257], [257, 386], [422, 424], [424, 430], [430, 422], [445, 342], [342, 276], [276, 445], [422, 273], [273, 424], [424, 422], [306, 292], [292, 307], [307, 306], [352, 366], [366, 345], [345, 352], [268, 271], [271, 302], [302, 268], [358, 423], [423, 371], [371, 358], [327, 294], [294, 460], [460, 327], [331, 279], [279, 294], [294, 331], [303, 271], [271, 304], [304, 303], [436, 432], [432, 427], [427, 436], [304, 272], [272, 408], [408, 304], [395, 394], [394, 431], [431, 395], [378, 395], [395, 400], [400, 378], [296, 334], [334, 299], [299, 296], [6, 351], [351, 168], [168, 6], [376, 352], [352, 411], [411, 376], [307, 325], [325, 320], [320, 307], [285, 295], [295, 336], [336, 285], [320, 319], [319, 404], [404, 320], [329, 330], [330, 349], [349, 329], [334, 293], [293, 333], [333, 334], [366, 323], [323, 447], [447, 366], [316, 15], [15, 315], [315, 316], [331, 358], [358, 279], [279, 331], [317, 14], [14, 316], [316, 317], [8, 285], [285, 9], [9, 8], [277, 329], [329, 350], [350, 277], [253, 374], [374, 252], [252, 253], [319, 318], [318, 403], [403, 319], [351, 6], [6, 419], [419, 351], [324, 318], [318, 325], [325, 324], [397, 367], [367, 365], [365, 397], [288, 435], [435, 397], [397, 288], [278, 344], [344, 439], [439, 278], [310, 272], [272, 311], [311, 310], [248, 195], [195, 281], [281, 248], [375, 273], [273, 291], [291, 375], [175, 396], [396, 199], [199, 175], [312, 311], [311, 268], [268, 312], [276, 283], [283, 445], [445, 276], [390, 373], [373, 339], [339, 390], [295, 282], [282, 296], [296, 295], [448, 449], [449, 346], [346, 448], [356, 264], [264, 454], [454, 356], [337, 336], [336, 299], [299, 337], [337, 338], [338, 151], [151, 337], [294, 278], [278, 455], [455, 294], [308, 292], [292, 415], [415, 308], [429, 358], [358, 355], [355, 429], [265, 340], [340, 372], [372, 265], [352, 346], [346, 280], [280, 352], [295, 442], [442, 282], [282, 295], [354, 19], [19, 370], [370, 354], [285, 441], [441, 295], [295, 285], [195, 248], [248, 197], [197, 195], [457, 440], [440, 274], [274, 457], [301, 300], [300, 368], [368, 301], [417, 351], [351, 465], [465, 417], [251, 301], [301, 389], [389, 251], [394, 395], [395, 379], [379, 394], [399, 412], [412, 419], [419, 399], [410, 436], [436, 322], [322, 410], [326, 2], [2, 393], [393, 326], [354, 370], [370, 461], [461, 354], [393, 164], [164, 267], [267, 393], [268, 302], [302, 12], [12, 268], [312, 268], [268, 13], [13, 312], [298, 293], [293, 301], [301, 298], [265, 446], [446, 340], [340, 265], [280, 330], [330, 425], [425, 280], [322, 426], [426, 391], [391, 322], [420, 429], [429, 437], [437, 420], [393, 391], [391, 326], [326, 393], [344, 440], [440, 438], [438, 344], [458, 459], [459, 461], [461, 458], [364, 434], [434, 394], [394, 364], [428, 396], [396, 262], [262, 428], [274, 354], [354, 457], [457, 274], [317, 316], [316, 402], [402, 317], [316, 315], [315, 403], [403, 316], [315, 314], [314, 404], [404, 315], [314, 313], [313, 405], [405, 314], [313, 421], [421, 406], [406, 313], [323, 366], [366, 361], [361, 323], [292, 306], [306, 407], [407, 292], [306, 291], [291, 408], [408, 306], [291, 287], [287, 409], [409, 291], [287, 432], [432, 410], [410, 287], [427, 434], [434, 411], [411, 427], [372, 264], [264, 383], [383, 372], [459, 309], [309, 457], [457, 459], [366, 352], [352, 401], [401, 366], [1, 274], [274, 4], [4, 1], [418, 421], [421, 262], [262, 418], [331, 294], [294, 358], [358, 331], [435, 433], [433, 367], [367, 435], [392, 289], [289, 439], [439, 392], [328, 462], [462, 326], [326, 328], [94, 2], [2, 370], [370, 94], [289, 305], [305, 455], [455, 289], [339, 254], [254, 448], [448, 339], [359, 255], [255, 446], [446, 359], [254, 253], [253, 449], [449, 254], [253, 252], [252, 450], [450, 253], [252, 256], [256, 451], [451, 252], [256, 341], [341, 452], [452, 256], [414, 413], [413, 463], [463, 414], [286, 441], [441, 414], [414, 286], [286, 258], [258, 441], [441, 286], [258, 257], [257, 442], [442, 258], [257, 259], [259, 443], [443, 257], [259, 260], [260, 444], [444, 259], [260, 467], [467, 445], [445, 260], [309, 459], [459, 250], [250, 309], [305, 289], [289, 290], [290, 305], [305, 290], [290, 460], [460, 305], [401, 376], [376, 435], [435, 401], [309, 250], [250, 392], [392, 309], [376, 411], [411, 433], [433, 376], [453, 341], [341, 464], [464, 453], [357, 453], [453, 465], [465, 357], [343, 357], [357, 412], [412, 343], [437, 343], [343, 399], [399, 437], [344, 360], [360, 440], [440, 344], [420, 437], [437, 456], [456, 420], [360, 420], [420, 363], [363, 360], [361, 401], [401, 288], [288, 361], [265, 372], [372, 353], [353, 265], [390, 339], [339, 249], [249, 390], [339, 448], [448, 255], [255, 339]);
	function kc(t) {
		t.j = {
			faceLandmarks: [],
			faceBlendshapes: [],
			facialTransformationMatrixes: []
		};
	}
	var Sc = class extends dc {
		constructor(t, e) {
			super(new ac(t, e), "image_in", "norm_rect", !1), this.j = {
				faceLandmarks: [],
				faceBlendshapes: [],
				facialTransformationMatrixes: []
			}, this.outputFacialTransformationMatrixes = this.outputFaceBlendshapes = !1, wn(t = this.h = new Js(), 0, 1, e = new Xs()), this.A = new $s(), wn(this.h, 0, 3, this.A), this.u = new zs(), wn(this.h, 0, 2, this.u), xn(this.u, 4, 1), Ln(this.u, 2, .5), Ln(this.A, 2, .5), Ln(this.h, 4, .5);
		}
		get baseOptions() {
			return yn(this.h, Xs, 1);
		}
		set baseOptions(t) {
			wn(this.h, 0, 1, t);
		}
		o(t) {
			return "numFaces" in t && xn(this.u, 4, t.numFaces ?? 1), "minFaceDetectionConfidence" in t && Ln(this.u, 2, t.minFaceDetectionConfidence ?? .5), "minTrackingConfidence" in t && Ln(this.h, 4, t.minTrackingConfidence ?? .5), "minFacePresenceConfidence" in t && Ln(this.A, 2, t.minFacePresenceConfidence ?? .5), "outputFaceBlendshapes" in t && (this.outputFaceBlendshapes = !!t.outputFaceBlendshapes), "outputFacialTransformationMatrixes" in t && (this.outputFacialTransformationMatrixes = !!t.outputFacialTransformationMatrixes), this.l(t);
		}
		F(t, e) {
			return kc(this), uc(this, t, e), this.j;
		}
		G(t, e, n) {
			return kc(this), lc(this, t, n, e), this.j;
		}
		m() {
			var t = new ls();
			hs(t, "image_in"), hs(t, "norm_rect"), us(t, "face_landmarks");
			const e = new Qi();
			xr(e, Qs, this.h);
			const n = new is();
			Rn(n, 2, "mediapipe.tasks.vision.face_landmarker.FaceLandmarkerGraph"), ns(n, "IMAGE:image_in"), ns(n, "NORM_RECT:norm_rect"), rs(n, "NORM_LANDMARKS:face_landmarks"), n.o(e), cs(t, n), this.g.attachProtoVectorListener("face_landmarks", ((t, e) => {
				for (const e of t) t = ks(e), this.j.faceLandmarks.push(Ho(t));
				ua(this, e);
			})), this.g.attachEmptyPacketListener("face_landmarks", ((t) => {
				ua(this, t);
			})), this.outputFaceBlendshapes && (us(t, "blendshapes"), rs(n, "BLENDSHAPES:blendshapes"), this.g.attachProtoVectorListener("blendshapes", ((t, e) => {
				if (this.outputFaceBlendshapes) for (const e of t) t = ys(e), this.j.faceBlendshapes.push(jo(t.g() ?? []));
				ua(this, e);
			})), this.g.attachEmptyPacketListener("blendshapes", ((t) => {
				ua(this, t);
			}))), this.outputFacialTransformationMatrixes && (us(t, "face_geometry"), rs(n, "FACE_GEOMETRY:face_geometry"), this.g.attachProtoVectorListener("face_geometry", ((t, e) => {
				if (this.outputFacialTransformationMatrixes) for (const e of t) (t = yn(t = qs(e), Ss, 2)) && this.j.facialTransformationMatrixes.push({
					rows: kn(t, 1) ?? 0 ?? 0,
					columns: kn(t, 2) ?? 0 ?? 0,
					data: en(t, 3, $t, tn()).slice() ?? []
				});
				ua(this, e);
			})), this.g.attachEmptyPacketListener("face_geometry", ((t) => {
				ua(this, t);
			}))), t = t.g(), this.setGraph(new Uint8Array(t), !0);
		}
	};
	Sc.prototype.detectForVideo = Sc.prototype.G, Sc.prototype.detect = Sc.prototype.F, Sc.prototype.setOptions = Sc.prototype.o, Sc.createFromModelPath = function(t, e) {
		return cc(Sc, t, { baseOptions: { modelAssetPath: e } });
	}, Sc.createFromModelBuffer = function(t, e) {
		return cc(Sc, t, { baseOptions: { modelAssetBuffer: e } });
	}, Sc.createFromOptions = function(t, e) {
		return cc(Sc, t, e);
	}, Sc.FACE_LANDMARKS_LIPS = gc, Sc.FACE_LANDMARKS_LEFT_EYE = mc, Sc.FACE_LANDMARKS_LEFT_EYEBROW = yc, Sc.FACE_LANDMARKS_LEFT_IRIS = _c, Sc.FACE_LANDMARKS_RIGHT_EYE = vc, Sc.FACE_LANDMARKS_RIGHT_EYEBROW = Ec, Sc.FACE_LANDMARKS_RIGHT_IRIS = wc, Sc.FACE_LANDMARKS_FACE_OVAL = Tc, Sc.FACE_LANDMARKS_CONTOURS = Ac, Sc.FACE_LANDMARKS_TESSELATION = bc;
	var xc = ic([0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]);
	function Lc(t) {
		t.gestures = [], t.landmarks = [], t.worldLandmarks = [], t.handedness = [];
	}
	function Rc(t) {
		return 0 === t.gestures.length ? {
			gestures: [],
			landmarks: [],
			worldLandmarks: [],
			handedness: [],
			handednesses: []
		} : {
			gestures: t.gestures,
			landmarks: t.landmarks,
			worldLandmarks: t.worldLandmarks,
			handedness: t.handedness,
			handednesses: t.handedness
		};
	}
	function Ic(t, e = !0) {
		const n = [];
		for (const i of t) {
			var r = ys(i);
			t = [];
			for (const n of r.g()) r = e && null != kn(n, 1) ? kn(n, 1) ?? 0 : -1, t.push({
				score: Sn(n, 2) ?? 0,
				index: r,
				categoryName: le($e(n, 3)) ?? "" ?? "",
				displayName: le($e(n, 4)) ?? "" ?? ""
			});
			n.push(t);
		}
		return n;
	}
	var Fc = class extends dc {
		constructor(t, e) {
			super(new ac(t, e), "image_in", "norm_rect", !1), this.gestures = [], this.landmarks = [], this.worldLandmarks = [], this.handedness = [], wn(t = this.j = new oo(), 0, 1, e = new Xs()), this.u = new so(), wn(this.j, 0, 2, this.u), this.D = new io(), wn(this.u, 0, 3, this.D), this.A = new ro(), wn(this.u, 0, 2, this.A), this.h = new no(), wn(this.j, 0, 3, this.h), Ln(this.A, 2, .5), Ln(this.u, 4, .5), Ln(this.D, 2, .5);
		}
		get baseOptions() {
			return yn(this.j, Xs, 1);
		}
		set baseOptions(t) {
			wn(this.j, 0, 1, t);
		}
		o(t) {
			if (xn(this.A, 3, t.numHands ?? 1), "minHandDetectionConfidence" in t && Ln(this.A, 2, t.minHandDetectionConfidence ?? .5), "minTrackingConfidence" in t && Ln(this.u, 4, t.minTrackingConfidence ?? .5), "minHandPresenceConfidence" in t && Ln(this.D, 2, t.minHandPresenceConfidence ?? .5), t.cannedGesturesClassifierOptions) {
				var e = new to(), n = e, r = Bo(t.cannedGesturesClassifierOptions, yn(this.h, to, 3)?.l());
				wn(n, 0, 2, r), wn(this.h, 0, 3, e);
			} else void 0 === t.cannedGesturesClassifierOptions && yn(this.h, to, 3)?.g();
			return t.customGesturesClassifierOptions ? (wn(n = e = new to(), 0, 2, r = Bo(t.customGesturesClassifierOptions, yn(this.h, to, 4)?.l())), wn(this.h, 0, 4, e)) : void 0 === t.customGesturesClassifierOptions && yn(this.h, to, 4)?.g(), this.l(t);
		}
		Ha(t, e) {
			return Lc(this), uc(this, t, e), Rc(this);
		}
		Ia(t, e, n) {
			return Lc(this), lc(this, t, n, e), Rc(this);
		}
		m() {
			var t = new ls();
			hs(t, "image_in"), hs(t, "norm_rect"), us(t, "hand_gestures"), us(t, "hand_landmarks"), us(t, "world_hand_landmarks"), us(t, "handedness");
			const e = new Qi();
			xr(e, lo, this.j);
			const n = new is();
			Rn(n, 2, "mediapipe.tasks.vision.gesture_recognizer.GestureRecognizerGraph"), ns(n, "IMAGE:image_in"), ns(n, "NORM_RECT:norm_rect"), rs(n, "HAND_GESTURES:hand_gestures"), rs(n, "LANDMARKS:hand_landmarks"), rs(n, "WORLD_LANDMARKS:world_hand_landmarks"), rs(n, "HANDEDNESS:handedness"), n.o(e), cs(t, n), this.g.attachProtoVectorListener("hand_landmarks", ((t, e) => {
				for (const e of t) {
					t = ks(e);
					const n = [];
					for (const e of vn(t, bs, 1)) n.push({
						x: Sn(e, 1) ?? 0,
						y: Sn(e, 2) ?? 0,
						z: Sn(e, 3) ?? 0,
						visibility: Sn(e, 4) ?? 0
					});
					this.landmarks.push(n);
				}
				ua(this, e);
			})), this.g.attachEmptyPacketListener("hand_landmarks", ((t) => {
				ua(this, t);
			})), this.g.attachProtoVectorListener("world_hand_landmarks", ((t, e) => {
				for (const e of t) {
					t = As(e);
					const n = [];
					for (const e of vn(t, Ts, 1)) n.push({
						x: Sn(e, 1) ?? 0,
						y: Sn(e, 2) ?? 0,
						z: Sn(e, 3) ?? 0,
						visibility: Sn(e, 4) ?? 0
					});
					this.worldLandmarks.push(n);
				}
				ua(this, e);
			})), this.g.attachEmptyPacketListener("world_hand_landmarks", ((t) => {
				ua(this, t);
			})), this.g.attachProtoVectorListener("hand_gestures", ((t, e) => {
				this.gestures.push(...Ic(t, !1)), ua(this, e);
			})), this.g.attachEmptyPacketListener("hand_gestures", ((t) => {
				ua(this, t);
			})), this.g.attachProtoVectorListener("handedness", ((t, e) => {
				this.handedness.push(...Ic(t)), ua(this, e);
			})), this.g.attachEmptyPacketListener("handedness", ((t) => {
				ua(this, t);
			})), t = t.g(), this.setGraph(new Uint8Array(t), !0);
		}
	};
	function Mc(t) {
		return {
			landmarks: t.landmarks,
			worldLandmarks: t.worldLandmarks,
			handednesses: t.handedness,
			handedness: t.handedness
		};
	}
	Fc.prototype.recognizeForVideo = Fc.prototype.Ia, Fc.prototype.recognize = Fc.prototype.Ha, Fc.prototype.setOptions = Fc.prototype.o, Fc.createFromModelPath = function(t, e) {
		return cc(Fc, t, { baseOptions: { modelAssetPath: e } });
	}, Fc.createFromModelBuffer = function(t, e) {
		return cc(Fc, t, { baseOptions: { modelAssetBuffer: e } });
	}, Fc.createFromOptions = function(t, e) {
		return cc(Fc, t, e);
	}, Fc.HAND_CONNECTIONS = xc;
	var Pc = class extends dc {
		constructor(t, e) {
			super(new ac(t, e), "image_in", "norm_rect", !1), this.landmarks = [], this.worldLandmarks = [], this.handedness = [], wn(t = this.h = new so(), 0, 1, e = new Xs()), this.u = new io(), wn(this.h, 0, 3, this.u), this.j = new ro(), wn(this.h, 0, 2, this.j), xn(this.j, 3, 1), Ln(this.j, 2, .5), Ln(this.u, 2, .5), Ln(this.h, 4, .5);
		}
		get baseOptions() {
			return yn(this.h, Xs, 1);
		}
		set baseOptions(t) {
			wn(this.h, 0, 1, t);
		}
		o(t) {
			return "numHands" in t && xn(this.j, 3, t.numHands ?? 1), "minHandDetectionConfidence" in t && Ln(this.j, 2, t.minHandDetectionConfidence ?? .5), "minTrackingConfidence" in t && Ln(this.h, 4, t.minTrackingConfidence ?? .5), "minHandPresenceConfidence" in t && Ln(this.u, 2, t.minHandPresenceConfidence ?? .5), this.l(t);
		}
		F(t, e) {
			return this.landmarks = [], this.worldLandmarks = [], this.handedness = [], uc(this, t, e), Mc(this);
		}
		G(t, e, n) {
			return this.landmarks = [], this.worldLandmarks = [], this.handedness = [], lc(this, t, n, e), Mc(this);
		}
		m() {
			var t = new ls();
			hs(t, "image_in"), hs(t, "norm_rect"), us(t, "hand_landmarks"), us(t, "world_hand_landmarks"), us(t, "handedness");
			const e = new Qi();
			xr(e, fo, this.h);
			const n = new is();
			Rn(n, 2, "mediapipe.tasks.vision.hand_landmarker.HandLandmarkerGraph"), ns(n, "IMAGE:image_in"), ns(n, "NORM_RECT:norm_rect"), rs(n, "LANDMARKS:hand_landmarks"), rs(n, "WORLD_LANDMARKS:world_hand_landmarks"), rs(n, "HANDEDNESS:handedness"), n.o(e), cs(t, n), this.g.attachProtoVectorListener("hand_landmarks", ((t, e) => {
				for (const e of t) t = ks(e), this.landmarks.push(Ho(t));
				ua(this, e);
			})), this.g.attachEmptyPacketListener("hand_landmarks", ((t) => {
				ua(this, t);
			})), this.g.attachProtoVectorListener("world_hand_landmarks", ((t, e) => {
				for (const e of t) t = As(e), this.worldLandmarks.push(Wo(t));
				ua(this, e);
			})), this.g.attachEmptyPacketListener("world_hand_landmarks", ((t) => {
				ua(this, t);
			})), this.g.attachProtoVectorListener("handedness", ((t, e) => {
				var n = this.handedness, r = n.push;
				const i = [];
				for (const e of t) {
					t = ys(e);
					const n = [];
					for (const e of t.g()) n.push({
						score: Sn(e, 2) ?? 0,
						index: kn(e, 1) ?? 0 ?? -1,
						categoryName: le($e(e, 3)) ?? "" ?? "",
						displayName: le($e(e, 4)) ?? "" ?? ""
					});
					i.push(n);
				}
				r.call(n, ...i), ua(this, e);
			})), this.g.attachEmptyPacketListener("handedness", ((t) => {
				ua(this, t);
			})), t = t.g(), this.setGraph(new Uint8Array(t), !0);
		}
	};
	Pc.prototype.detectForVideo = Pc.prototype.G, Pc.prototype.detect = Pc.prototype.F, Pc.prototype.setOptions = Pc.prototype.o, Pc.createFromModelPath = function(t, e) {
		return cc(Pc, t, { baseOptions: { modelAssetPath: e } });
	}, Pc.createFromModelBuffer = function(t, e) {
		return cc(Pc, t, { baseOptions: { modelAssetBuffer: e } });
	}, Pc.createFromOptions = function(t, e) {
		return cc(Pc, t, e);
	}, Pc.HAND_CONNECTIONS = xc;
	var Cc = ic([0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10], [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19], [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20], [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28], [27, 29], [28, 30], [29, 31], [30, 32], [27, 31], [28, 32]);
	function Oc(t) {
		t.h = {
			faceLandmarks: [],
			faceBlendshapes: [],
			poseLandmarks: [],
			poseWorldLandmarks: [],
			poseSegmentationMasks: [],
			leftHandLandmarks: [],
			leftHandWorldLandmarks: [],
			rightHandLandmarks: [],
			rightHandWorldLandmarks: []
		};
	}
	function Nc(t) {
		try {
			if (!t.D) return t.h;
			t.D(t.h);
		} finally {
			da(t);
		}
	}
	function Uc(t, e) {
		t = ks(t), e.push(Ho(t));
	}
	var Dc = class extends dc {
		constructor(t, e) {
			super(new ac(t, e), "input_frames_image", null, !1), this.h = {
				faceLandmarks: [],
				faceBlendshapes: [],
				poseLandmarks: [],
				poseWorldLandmarks: [],
				poseSegmentationMasks: [],
				leftHandLandmarks: [],
				leftHandWorldLandmarks: [],
				rightHandLandmarks: [],
				rightHandWorldLandmarks: []
			}, this.outputPoseSegmentationMasks = this.outputFaceBlendshapes = !1, wn(t = this.j = new yo(), 0, 1, e = new Xs()), this.I = new io(), wn(this.j, 0, 2, this.I), this.W = new po(), wn(this.j, 0, 3, this.W), this.u = new zs(), wn(this.j, 0, 4, this.u), this.O = new $s(), wn(this.j, 0, 5, this.O), this.A = new go(), wn(this.j, 0, 6, this.A), this.M = new mo(), wn(this.j, 0, 7, this.M), Ln(this.u, 2, .5), Ln(this.u, 3, .3), Ln(this.O, 2, .5), Ln(this.A, 2, .5), Ln(this.A, 3, .3), Ln(this.M, 2, .5), Ln(this.I, 2, .5);
		}
		get baseOptions() {
			return yn(this.j, Xs, 1);
		}
		set baseOptions(t) {
			wn(this.j, 0, 1, t);
		}
		o(t) {
			return "minFaceDetectionConfidence" in t && Ln(this.u, 2, t.minFaceDetectionConfidence ?? .5), "minFaceSuppressionThreshold" in t && Ln(this.u, 3, t.minFaceSuppressionThreshold ?? .3), "minFacePresenceConfidence" in t && Ln(this.O, 2, t.minFacePresenceConfidence ?? .5), "outputFaceBlendshapes" in t && (this.outputFaceBlendshapes = !!t.outputFaceBlendshapes), "minPoseDetectionConfidence" in t && Ln(this.A, 2, t.minPoseDetectionConfidence ?? .5), "minPoseSuppressionThreshold" in t && Ln(this.A, 3, t.minPoseSuppressionThreshold ?? .3), "minPosePresenceConfidence" in t && Ln(this.M, 2, t.minPosePresenceConfidence ?? .5), "outputPoseSegmentationMasks" in t && (this.outputPoseSegmentationMasks = !!t.outputPoseSegmentationMasks), "minHandLandmarksConfidence" in t && Ln(this.I, 2, t.minHandLandmarksConfidence ?? .5), this.l(t);
		}
		F(t, e, n) {
			const r = "function" != typeof e ? e : {};
			return this.D = "function" == typeof e ? e : n, Oc(this), uc(this, t, r), Nc(this);
		}
		G(t, e, n, r) {
			const i = "function" != typeof n ? n : {};
			return this.D = "function" == typeof n ? n : r, Oc(this), lc(this, t, i, e), Nc(this);
		}
		m() {
			var t = new ls();
			hs(t, "input_frames_image"), us(t, "pose_landmarks"), us(t, "pose_world_landmarks"), us(t, "face_landmarks"), us(t, "left_hand_landmarks"), us(t, "left_hand_world_landmarks"), us(t, "right_hand_landmarks"), us(t, "right_hand_world_landmarks");
			const e = new Qi(), n = new Bi();
			Rn(n, 1, "type.googleapis.com/mediapipe.tasks.vision.holistic_landmarker.proto.HolisticLandmarkerGraphOptions"), function(t, e) {
				if (null != e) if (Array.isArray(e)) Ze(t, 2, Ie(e, 0, Me));
				else {
					if (!("string" == typeof e || e instanceof F || x(e))) throw Error("invalid value in Any.value field: " + e + " expected a ByteString, a base64 encoded string, a Uint8Array or a jspb array");
					hn(t, 2, ht(e, !1), R());
				}
			}(n, this.j.g());
			const r = new is();
			Rn(r, 2, "mediapipe.tasks.vision.holistic_landmarker.HolisticLandmarkerGraph"), bn(r, 8, Bi, n), ns(r, "IMAGE:input_frames_image"), rs(r, "POSE_LANDMARKS:pose_landmarks"), rs(r, "POSE_WORLD_LANDMARKS:pose_world_landmarks"), rs(r, "FACE_LANDMARKS:face_landmarks"), rs(r, "LEFT_HAND_LANDMARKS:left_hand_landmarks"), rs(r, "LEFT_HAND_WORLD_LANDMARKS:left_hand_world_landmarks"), rs(r, "RIGHT_HAND_LANDMARKS:right_hand_landmarks"), rs(r, "RIGHT_HAND_WORLD_LANDMARKS:right_hand_world_landmarks"), r.o(e), cs(t, r), la(this, t), this.g.attachProtoListener("pose_landmarks", ((t, e) => {
				Uc(t, this.h.poseLandmarks), ua(this, e);
			})), this.g.attachEmptyPacketListener("pose_landmarks", ((t) => {
				ua(this, t);
			})), this.g.attachProtoListener("pose_world_landmarks", ((t, e) => {
				var n = this.h.poseWorldLandmarks;
				t = As(t), n.push(Wo(t)), ua(this, e);
			})), this.g.attachEmptyPacketListener("pose_world_landmarks", ((t) => {
				ua(this, t);
			})), this.outputPoseSegmentationMasks && (rs(r, "POSE_SEGMENTATION_MASK:pose_segmentation_mask"), fa(this, "pose_segmentation_mask"), this.g.Z("pose_segmentation_mask", ((t, e) => {
				this.h.poseSegmentationMasks = [fc(this, t, !0, !this.D)], ua(this, e);
			})), this.g.attachEmptyPacketListener("pose_segmentation_mask", ((t) => {
				this.h.poseSegmentationMasks = [], ua(this, t);
			}))), this.g.attachProtoListener("face_landmarks", ((t, e) => {
				Uc(t, this.h.faceLandmarks), ua(this, e);
			})), this.g.attachEmptyPacketListener("face_landmarks", ((t) => {
				ua(this, t);
			})), this.outputFaceBlendshapes && (us(t, "extra_blendshapes"), rs(r, "FACE_BLENDSHAPES:extra_blendshapes"), this.g.attachProtoListener("extra_blendshapes", ((t, e) => {
				var n = this.h.faceBlendshapes;
				this.outputFaceBlendshapes && (t = ys(t), n.push(jo(t.g() ?? []))), ua(this, e);
			})), this.g.attachEmptyPacketListener("extra_blendshapes", ((t) => {
				ua(this, t);
			}))), this.g.attachProtoListener("left_hand_landmarks", ((t, e) => {
				Uc(t, this.h.leftHandLandmarks), ua(this, e);
			})), this.g.attachEmptyPacketListener("left_hand_landmarks", ((t) => {
				ua(this, t);
			})), this.g.attachProtoListener("left_hand_world_landmarks", ((t, e) => {
				var n = this.h.leftHandWorldLandmarks;
				t = As(t), n.push(Wo(t)), ua(this, e);
			})), this.g.attachEmptyPacketListener("left_hand_world_landmarks", ((t) => {
				ua(this, t);
			})), this.g.attachProtoListener("right_hand_landmarks", ((t, e) => {
				Uc(t, this.h.rightHandLandmarks), ua(this, e);
			})), this.g.attachEmptyPacketListener("right_hand_landmarks", ((t) => {
				ua(this, t);
			})), this.g.attachProtoListener("right_hand_world_landmarks", ((t, e) => {
				var n = this.h.rightHandWorldLandmarks;
				t = As(t), n.push(Wo(t)), ua(this, e);
			})), this.g.attachEmptyPacketListener("right_hand_world_landmarks", ((t) => {
				ua(this, t);
			})), t = t.g(), this.setGraph(new Uint8Array(t), !0);
		}
	};
	Dc.prototype.detectForVideo = Dc.prototype.G, Dc.prototype.detect = Dc.prototype.F, Dc.prototype.setOptions = Dc.prototype.o, Dc.createFromModelPath = function(t, e) {
		return cc(Dc, t, { baseOptions: { modelAssetPath: e } });
	}, Dc.createFromModelBuffer = function(t, e) {
		return cc(Dc, t, { baseOptions: { modelAssetBuffer: e } });
	}, Dc.createFromOptions = function(t, e) {
		return cc(Dc, t, e);
	}, Dc.HAND_CONNECTIONS = xc, Dc.POSE_CONNECTIONS = Cc, Dc.FACE_LANDMARKS_LIPS = gc, Dc.FACE_LANDMARKS_LEFT_EYE = mc, Dc.FACE_LANDMARKS_LEFT_EYEBROW = yc, Dc.FACE_LANDMARKS_LEFT_IRIS = _c, Dc.FACE_LANDMARKS_RIGHT_EYE = vc, Dc.FACE_LANDMARKS_RIGHT_EYEBROW = Ec, Dc.FACE_LANDMARKS_RIGHT_IRIS = wc, Dc.FACE_LANDMARKS_FACE_OVAL = Tc, Dc.FACE_LANDMARKS_CONTOURS = Ac, Dc.FACE_LANDMARKS_TESSELATION = bc;
	var Bc = class extends dc {
		constructor(t, e) {
			super(new ac(t, e), "input_image", "norm_rect", !0), this.j = { classifications: [] }, wn(t = this.h = new Eo(), 0, 1, e = new Xs());
		}
		get baseOptions() {
			return yn(this.h, Xs, 1);
		}
		set baseOptions(t) {
			wn(this.h, 0, 1, t);
		}
		o(t) {
			return wn(this.h, 0, 2, Bo(t, yn(this.h, Ns, 2))), this.l(t);
		}
		sa(t, e) {
			return this.j = { classifications: [] }, uc(this, t, e), this.j;
		}
		ta(t, e, n) {
			return this.j = { classifications: [] }, lc(this, t, n, e), this.j;
		}
		m() {
			var t = new ls();
			hs(t, "input_image"), hs(t, "norm_rect"), us(t, "classifications");
			const e = new Qi();
			xr(e, wo, this.h);
			const n = new is();
			Rn(n, 2, "mediapipe.tasks.vision.image_classifier.ImageClassifierGraph"), ns(n, "IMAGE:input_image"), ns(n, "NORM_RECT:norm_rect"), rs(n, "CLASSIFICATIONS:classifications"), n.o(e), cs(t, n), this.g.attachProtoListener("classifications", ((t, e) => {
				this.j = Vo(Is(t)), ua(this, e);
			})), this.g.attachEmptyPacketListener("classifications", ((t) => {
				ua(this, t);
			})), t = t.g(), this.setGraph(new Uint8Array(t), !0);
		}
	};
	Bc.prototype.classifyForVideo = Bc.prototype.ta, Bc.prototype.classify = Bc.prototype.sa, Bc.prototype.setOptions = Bc.prototype.o, Bc.createFromModelPath = function(t, e) {
		return cc(Bc, t, { baseOptions: { modelAssetPath: e } });
	}, Bc.createFromModelBuffer = function(t, e) {
		return cc(Bc, t, { baseOptions: { modelAssetBuffer: e } });
	}, Bc.createFromOptions = function(t, e) {
		return cc(Bc, t, e);
	};
	var Gc = class extends dc {
		constructor(t, e) {
			super(new ac(t, e), "image_in", "norm_rect", !0), this.h = new To(), this.embeddings = { embeddings: [] }, wn(t = this.h, 0, 1, e = new Xs());
		}
		get baseOptions() {
			return yn(this.h, Xs, 1);
		}
		set baseOptions(t) {
			wn(this.h, 0, 1, t);
		}
		o(t) {
			var e = this.h, n = yn(this.h, Ds, 2);
			return n = n ? n.clone() : new Ds(), void 0 !== t.l2Normalize ? Ze(n, 1, Jt(t.l2Normalize)) : "l2Normalize" in t && Ze(n, 1), void 0 !== t.quantize ? Ze(n, 2, Jt(t.quantize)) : "quantize" in t && Ze(n, 2), wn(e, 0, 2, n), this.l(t);
		}
		za(t, e) {
			return uc(this, t, e), this.embeddings;
		}
		Aa(t, e, n) {
			return lc(this, t, n, e), this.embeddings;
		}
		m() {
			var t = new ls();
			hs(t, "image_in"), hs(t, "norm_rect"), us(t, "embeddings_out");
			const e = new Qi();
			xr(e, Ao, this.h);
			const n = new is();
			Rn(n, 2, "mediapipe.tasks.vision.image_embedder.ImageEmbedderGraph"), ns(n, "IMAGE:image_in"), ns(n, "NORM_RECT:norm_rect"), rs(n, "EMBEDDINGS:embeddings_out"), n.o(e), cs(t, n), this.g.attachProtoListener("embeddings_out", ((t, e) => {
				t = Os(t), this.embeddings = function(t) {
					return {
						embeddings: vn(t, Ps, 1).map(((t) => {
							const e = {
								headIndex: kn(t, 3) ?? 0 ?? -1,
								headName: le($e(t, 4)) ?? "" ?? ""
							};
							var n = t.v;
							return void 0 !== mn(n, 0 | n[Q], Fs, ln(t, 1)) ? (t = en(t = yn(t, Fs, ln(t, 1), void 0), 1, $t, tn()), e.floatEmbedding = t.slice()) : (n = new Uint8Array(0), e.quantizedEmbedding = yn(t, Ms, ln(t, 2), void 0)?.na()?.h() ?? n), e;
						})),
						timestampMs: Go($e(t, 2, void 0, void 0, ce) ?? Ye)
					};
				}(t), ua(this, e);
			})), this.g.attachEmptyPacketListener("embeddings_out", ((t) => {
				ua(this, t);
			})), t = t.g(), this.setGraph(new Uint8Array(t), !0);
		}
	};
	Gc.cosineSimilarity = function(t, e) {
		if (t.floatEmbedding && e.floatEmbedding) t = Ko(t.floatEmbedding, e.floatEmbedding);
		else {
			if (!t.quantizedEmbedding || !e.quantizedEmbedding) throw Error("Cannot compute cosine similarity between quantized and float embeddings.");
			t = Ko(zo(t.quantizedEmbedding), zo(e.quantizedEmbedding));
		}
		return t;
	}, Gc.prototype.embedForVideo = Gc.prototype.Aa, Gc.prototype.embed = Gc.prototype.za, Gc.prototype.setOptions = Gc.prototype.o, Gc.createFromModelPath = function(t, e) {
		return cc(Gc, t, { baseOptions: { modelAssetPath: e } });
	}, Gc.createFromModelBuffer = function(t, e) {
		return cc(Gc, t, { baseOptions: { modelAssetBuffer: e } });
	}, Gc.createFromOptions = function(t, e) {
		return cc(Gc, t, e);
	};
	var jc = class {
		constructor(t, e, n) {
			this.confidenceMasks = t, this.categoryMask = e, this.qualityScores = n;
		}
		close() {
			this.confidenceMasks?.forEach(((t) => {
				t.close();
			})), this.categoryMask?.close();
		}
	};
	function Vc(t) {
		const e = function(t) {
			return vn(t, is, 1);
		}(t.ca()).filter(((t) => (le($e(t, 1)) ?? "").includes("mediapipe.tasks.TensorsToSegmentationCalculator")));
		if (t.u = [], e.length > 1) throw Error("The graph has more than one mediapipe.tasks.TensorsToSegmentationCalculator.");
		1 === e.length && (yn(e[0], Qi, 7)?.j()?.g() ?? /* @__PURE__ */ new Map()).forEach(((e, n) => {
			t.u[Number(n)] = le($e(e, 1)) ?? "";
		}));
	}
	function Xc(t) {
		t.categoryMask = void 0, t.confidenceMasks = void 0, t.qualityScores = void 0;
	}
	function Hc(t) {
		try {
			const e = new jc(t.confidenceMasks, t.categoryMask, t.qualityScores);
			if (!t.j) return e;
			t.j(e);
		} finally {
			da(t);
		}
	}
	jc.prototype.close = jc.prototype.close;
	var Wc = class extends dc {
		constructor(t, e) {
			super(new ac(t, e), "image_in", "norm_rect", !1), this.u = [], this.outputCategoryMask = !1, this.outputConfidenceMasks = !0, this.h = new Lo(), this.A = new bo(), wn(this.h, 0, 3, this.A), wn(t = this.h, 0, 1, e = new Xs());
		}
		get baseOptions() {
			return yn(this.h, Xs, 1);
		}
		set baseOptions(t) {
			wn(this.h, 0, 1, t);
		}
		o(t) {
			return void 0 !== t.displayNamesLocale ? Ze(this.h, 2, ue(t.displayNamesLocale)) : "displayNamesLocale" in t && Ze(this.h, 2), "outputCategoryMask" in t && (this.outputCategoryMask = t.outputCategoryMask ?? !1), "outputConfidenceMasks" in t && (this.outputConfidenceMasks = t.outputConfidenceMasks ?? !0), super.l(t);
		}
		L() {
			Vc(this);
		}
		segment(t, e, n) {
			const r = "function" != typeof e ? e : {};
			return this.j = "function" == typeof e ? e : n, Xc(this), uc(this, t, r), Hc(this);
		}
		La(t, e, n, r) {
			const i = "function" != typeof n ? n : {};
			return this.j = "function" == typeof n ? n : r, Xc(this), lc(this, t, i, e), Hc(this);
		}
		Da() {
			return this.u;
		}
		m() {
			var t = new ls();
			hs(t, "image_in"), hs(t, "norm_rect");
			const e = new Qi();
			xr(e, Ro, this.h);
			const n = new is();
			Rn(n, 2, "mediapipe.tasks.vision.image_segmenter.ImageSegmenterGraph"), ns(n, "IMAGE:image_in"), ns(n, "NORM_RECT:norm_rect"), n.o(e), cs(t, n), la(this, t), this.outputConfidenceMasks && (us(t, "confidence_masks"), rs(n, "CONFIDENCE_MASKS:confidence_masks"), fa(this, "confidence_masks"), this.g.aa("confidence_masks", ((t, e) => {
				this.confidenceMasks = t.map(((t) => fc(this, t, !0, !this.j))), ua(this, e);
			})), this.g.attachEmptyPacketListener("confidence_masks", ((t) => {
				this.confidenceMasks = [], ua(this, t);
			}))), this.outputCategoryMask && (us(t, "category_mask"), rs(n, "CATEGORY_MASK:category_mask"), fa(this, "category_mask"), this.g.Z("category_mask", ((t, e) => {
				this.categoryMask = fc(this, t, !1, !this.j), ua(this, e);
			})), this.g.attachEmptyPacketListener("category_mask", ((t) => {
				this.categoryMask = void 0, ua(this, t);
			}))), us(t, "quality_scores"), rs(n, "QUALITY_SCORES:quality_scores"), this.g.attachFloatVectorListener("quality_scores", ((t, e) => {
				this.qualityScores = t, ua(this, e);
			})), this.g.attachEmptyPacketListener("quality_scores", ((t) => {
				this.categoryMask = void 0, ua(this, t);
			})), t = t.g(), this.setGraph(new Uint8Array(t), !0);
		}
	};
	Wc.prototype.getLabels = Wc.prototype.Da, Wc.prototype.segmentForVideo = Wc.prototype.La, Wc.prototype.segment = Wc.prototype.segment, Wc.prototype.setOptions = Wc.prototype.o, Wc.createFromModelPath = function(t, e) {
		return cc(Wc, t, { baseOptions: { modelAssetPath: e } });
	}, Wc.createFromModelBuffer = function(t, e) {
		return cc(Wc, t, { baseOptions: { modelAssetBuffer: e } });
	}, Wc.createFromOptions = function(t, e) {
		return cc(Wc, t, e);
	};
	var zc = class {
		constructor(t, e, n) {
			this.confidenceMasks = t, this.categoryMask = e, this.qualityScores = n;
		}
		close() {
			this.confidenceMasks?.forEach(((t) => {
				t.close();
			})), this.categoryMask?.close();
		}
	};
	zc.prototype.close = zc.prototype.close;
	var Kc = class extends dc {
		constructor(t, e) {
			super(new ac(t, e), "image_in", "norm_rect_in", !1), this.outputCategoryMask = !1, this.outputConfidenceMasks = !0, this.h = new Lo(), this.u = new bo(), wn(this.h, 0, 3, this.u), wn(t = this.h, 0, 1, e = new Xs());
		}
		get baseOptions() {
			return yn(this.h, Xs, 1);
		}
		set baseOptions(t) {
			wn(this.h, 0, 1, t);
		}
		o(t) {
			return "outputCategoryMask" in t && (this.outputCategoryMask = t.outputCategoryMask ?? !1), "outputConfidenceMasks" in t && (this.outputConfidenceMasks = t.outputConfidenceMasks ?? !0), super.l(t);
		}
		segment(t, e, n, r) {
			const i = "function" != typeof n ? n : {};
			if (this.j = "function" == typeof n ? n : r, this.qualityScores = this.categoryMask = this.confidenceMasks = void 0, n = this.C + 1, r = new Po(), e.keypoint && e.scribble) throw Error("Cannot provide both keypoint and scribble.");
			if (e.keypoint) {
				var s = new Io();
				hn(s, 3, Jt(!0), !1), hn(s, 1, qt(e.keypoint.x), 0), hn(s, 2, qt(e.keypoint.y), 0), Tn(r, 1, Co, s);
			} else {
				if (!e.scribble) throw Error("Must provide either a keypoint or a scribble.");
				{
					const t = new Mo();
					for (s of e.scribble) hn(e = new Io(), 3, Jt(!0), !1), hn(e, 1, qt(s.x), 0), hn(e, 2, qt(s.y), 0), bn(t, 1, Io, e);
					Tn(r, 2, Co, t);
				}
			}
			this.g.addProtoToStream(r.g(), "mediapipe.tasks.vision.interactive_segmenter.proto.RegionOfInterest", "roi_in", n), uc(this, t, i);
			t: {
				try {
					const t = new zc(this.confidenceMasks, this.categoryMask, this.qualityScores);
					if (!this.j) {
						var o = t;
						break t;
					}
					this.j(t);
				} finally {
					da(this);
				}
				o = void 0;
			}
			return o;
		}
		m() {
			var t = new ls();
			hs(t, "image_in"), hs(t, "roi_in"), hs(t, "norm_rect_in");
			const e = new Qi();
			xr(e, Ro, this.h);
			const n = new is();
			Rn(n, 2, "mediapipe.tasks.vision.interactive_segmenter.InteractiveSegmenterGraphV2"), ns(n, "IMAGE:image_in"), ns(n, "ROI:roi_in"), ns(n, "NORM_RECT:norm_rect_in"), n.o(e), cs(t, n), la(this, t), this.outputConfidenceMasks && (us(t, "confidence_masks"), rs(n, "CONFIDENCE_MASKS:confidence_masks"), fa(this, "confidence_masks"), this.g.aa("confidence_masks", ((t, e) => {
				this.confidenceMasks = t.map(((t) => fc(this, t, !0, !this.j))), ua(this, e);
			})), this.g.attachEmptyPacketListener("confidence_masks", ((t) => {
				this.confidenceMasks = [], ua(this, t);
			}))), this.outputCategoryMask && (us(t, "category_mask"), rs(n, "CATEGORY_MASK:category_mask"), fa(this, "category_mask"), this.g.Z("category_mask", ((t, e) => {
				this.categoryMask = fc(this, t, !1, !this.j), ua(this, e);
			})), this.g.attachEmptyPacketListener("category_mask", ((t) => {
				this.categoryMask = void 0, ua(this, t);
			}))), us(t, "quality_scores"), rs(n, "QUALITY_SCORES:quality_scores"), this.g.attachFloatVectorListener("quality_scores", ((t, e) => {
				this.qualityScores = t, ua(this, e);
			})), this.g.attachEmptyPacketListener("quality_scores", ((t) => {
				this.categoryMask = void 0, ua(this, t);
			})), t = t.g(), this.setGraph(new Uint8Array(t), !0);
		}
	};
	Kc.prototype.segment = Kc.prototype.segment, Kc.prototype.setOptions = Kc.prototype.o, Kc.createFromModelPath = function(t, e) {
		return cc(Kc, t, { baseOptions: { modelAssetPath: e } });
	}, Kc.createFromModelBuffer = function(t, e) {
		return cc(Kc, t, { baseOptions: { modelAssetBuffer: e } });
	}, Kc.createFromOptions = function(t, e) {
		return cc(Kc, t, e);
	};
	var Yc = class extends dc {
		constructor(t, e) {
			super(new ac(t, e), "input_frame_gpu", "norm_rect", !1), this.j = { detections: [] }, wn(t = this.h = new Oo(), 0, 1, e = new Xs());
		}
		get baseOptions() {
			return yn(this.h, Xs, 1);
		}
		set baseOptions(t) {
			wn(this.h, 0, 1, t);
		}
		o(t) {
			return void 0 !== t.displayNamesLocale ? Ze(this.h, 2, ue(t.displayNamesLocale)) : "displayNamesLocale" in t && Ze(this.h, 2), void 0 !== t.maxResults ? xn(this.h, 3, t.maxResults) : "maxResults" in t && Ze(this.h, 3), void 0 !== t.scoreThreshold ? Ln(this.h, 4, t.scoreThreshold) : "scoreThreshold" in t && Ze(this.h, 4), void 0 !== t.categoryAllowlist ? In(this.h, 5, t.categoryAllowlist) : "categoryAllowlist" in t && Ze(this.h, 5), void 0 !== t.categoryDenylist ? In(this.h, 6, t.categoryDenylist) : "categoryDenylist" in t && Ze(this.h, 6), this.l(t);
		}
		F(t, e) {
			return this.j = { detections: [] }, uc(this, t, e), this.j;
		}
		G(t, e, n) {
			return this.j = { detections: [] }, lc(this, t, n, e), this.j;
		}
		m() {
			var t = new ls();
			hs(t, "input_frame_gpu"), hs(t, "norm_rect"), us(t, "detections");
			const e = new Qi();
			xr(e, No, this.h);
			const n = new is();
			Rn(n, 2, "mediapipe.tasks.vision.ObjectDetectorGraph"), ns(n, "IMAGE:input_frame_gpu"), ns(n, "NORM_RECT:norm_rect"), rs(n, "DETECTIONS:detections"), n.o(e), cs(t, n), this.g.attachProtoVectorListener("detections", ((t, e) => {
				for (const e of t) t = ws(e), this.j.detections.push(Xo(t));
				ua(this, e);
			})), this.g.attachEmptyPacketListener("detections", ((t) => {
				ua(this, t);
			})), t = t.g(), this.setGraph(new Uint8Array(t), !0);
		}
	};
	Yc.prototype.detectForVideo = Yc.prototype.G, Yc.prototype.detect = Yc.prototype.F, Yc.prototype.setOptions = Yc.prototype.o, Yc.createFromModelPath = async function(t, e) {
		return cc(Yc, t, { baseOptions: { modelAssetPath: e } });
	}, Yc.createFromModelBuffer = function(t, e) {
		return cc(Yc, t, { baseOptions: { modelAssetBuffer: e } });
	}, Yc.createFromOptions = function(t, e) {
		return cc(Yc, t, e);
	};
	var qc = class {
		constructor(t, e, n) {
			this.landmarks = t, this.worldLandmarks = e, this.segmentationMasks = n;
		}
		close() {
			this.segmentationMasks?.forEach(((t) => {
				t.close();
			}));
		}
	};
	function $c(t) {
		t.landmarks = [], t.worldLandmarks = [], t.segmentationMasks = void 0;
	}
	function Jc(t) {
		try {
			const e = new qc(t.landmarks, t.worldLandmarks, t.segmentationMasks);
			if (!t.u) return e;
			t.u(e);
		} finally {
			da(t);
		}
	}
	qc.prototype.close = qc.prototype.close;
	var Zc = class extends dc {
		constructor(t, e) {
			super(new ac(t, e), "image_in", "norm_rect", !1), this.landmarks = [], this.worldLandmarks = [], this.outputSegmentationMasks = !1, wn(t = this.h = new Uo(), 0, 1, e = new Xs()), this.A = new mo(), wn(this.h, 0, 3, this.A), this.j = new go(), wn(this.h, 0, 2, this.j), xn(this.j, 4, 1), Ln(this.j, 2, .5), Ln(this.A, 2, .5), Ln(this.h, 4, .5);
		}
		get baseOptions() {
			return yn(this.h, Xs, 1);
		}
		set baseOptions(t) {
			wn(this.h, 0, 1, t);
		}
		o(t) {
			return "numPoses" in t && xn(this.j, 4, t.numPoses ?? 1), "minPoseDetectionConfidence" in t && Ln(this.j, 2, t.minPoseDetectionConfidence ?? .5), "minTrackingConfidence" in t && Ln(this.h, 4, t.minTrackingConfidence ?? .5), "minPosePresenceConfidence" in t && Ln(this.A, 2, t.minPosePresenceConfidence ?? .5), "outputSegmentationMasks" in t && (this.outputSegmentationMasks = t.outputSegmentationMasks ?? !1), this.l(t);
		}
		F(t, e, n) {
			const r = "function" != typeof e ? e : {};
			return this.u = "function" == typeof e ? e : n, $c(this), uc(this, t, r), Jc(this);
		}
		G(t, e, n, r) {
			const i = "function" != typeof n ? n : {};
			return this.u = "function" == typeof n ? n : r, $c(this), lc(this, t, i, e), Jc(this);
		}
		m() {
			var t = new ls();
			hs(t, "image_in"), hs(t, "norm_rect"), us(t, "normalized_landmarks"), us(t, "world_landmarks"), us(t, "segmentation_masks");
			const e = new Qi();
			xr(e, Do, this.h);
			const n = new is();
			Rn(n, 2, "mediapipe.tasks.vision.pose_landmarker.PoseLandmarkerGraph"), ns(n, "IMAGE:image_in"), ns(n, "NORM_RECT:norm_rect"), rs(n, "NORM_LANDMARKS:normalized_landmarks"), rs(n, "WORLD_LANDMARKS:world_landmarks"), n.o(e), cs(t, n), la(this, t), this.g.attachProtoVectorListener("normalized_landmarks", ((t, e) => {
				this.landmarks = [];
				for (const e of t) t = ks(e), this.landmarks.push(Ho(t));
				ua(this, e);
			})), this.g.attachEmptyPacketListener("normalized_landmarks", ((t) => {
				this.landmarks = [], ua(this, t);
			})), this.g.attachProtoVectorListener("world_landmarks", ((t, e) => {
				this.worldLandmarks = [];
				for (const e of t) t = As(e), this.worldLandmarks.push(Wo(t));
				ua(this, e);
			})), this.g.attachEmptyPacketListener("world_landmarks", ((t) => {
				this.worldLandmarks = [], ua(this, t);
			})), this.outputSegmentationMasks && (rs(n, "SEGMENTATION_MASK:segmentation_masks"), fa(this, "segmentation_masks"), this.g.aa("segmentation_masks", ((t, e) => {
				this.segmentationMasks = t.map(((t) => fc(this, t, !0, !this.u))), ua(this, e);
			})), this.g.attachEmptyPacketListener("segmentation_masks", ((t) => {
				this.segmentationMasks = [], ua(this, t);
			}))), t = t.g(), this.setGraph(new Uint8Array(t), !0);
		}
	};
	Zc.prototype.detectForVideo = Zc.prototype.G, Zc.prototype.detect = Zc.prototype.F, Zc.prototype.setOptions = Zc.prototype.o, Zc.createFromModelPath = function(t, e) {
		return cc(Zc, t, { baseOptions: { modelAssetPath: e } });
	}, Zc.createFromModelBuffer = function(t, e) {
		return cc(Zc, t, { baseOptions: { modelAssetBuffer: e } });
	}, Zc.createFromOptions = function(t, e) {
		return cc(Zc, t, e);
	}, Zc.POSE_CONNECTIONS = Cc;
	//#endregion
	//#region play_src/poseEngine.js
	/**
	* poseEngine.js —— 在 file:// 下也能用的 MediaPipe Pose Landmarker 加载器（离线网页版专用）。
	*
	* 开发版（src/poseEstimator.js）靠 Vite 服务器按 URL 加载 WASM 和模型；双击打开的
	* file:// 页面不能 fetch 本地文件，所以这里换了三件事（都不改第三方文件本身）：
	*   1. WASM 运行时的胶水脚本 engine/vision_wasm_internal.js 用普通 <script> 加载，
	*      它会定义全局 ModuleFactory；我们先把它存到 window.__MP_MODULE_FACTORY。
	*      MediaPipe 自己加载胶水脚本时会加 crossOrigin，file:// 下会被拦，所以给它一个
	*      data: 小脚本，内容只是把存好的 ModuleFactory 放回去。
	*   2. WASM 二进制（约 11 MB）由 engine/wasm_b64.js 以 base64 字符串提供，解码后做成 Blob URL。
	*   3. 模型 pose_landmarker_lite.task（约 5.8 MB）由 engine/model_b64.js 提供，
	*      解码后用 modelAssetBuffer 直接交给 MediaPipe。
	* 这三个文件合计约 22 MB，只在第一次进入「我来练」时才加载，「看示例」不需要它们。
	*/
	function loadScript(src) {
		return new Promise((resolve, reject) => {
			const s = document.createElement("script");
			s.src = src;
			s.async = false;
			s.onload = () => resolve();
			s.onerror = () => reject(/* @__PURE__ */ new Error(`脚本加载失败：${src}（请确认解压后 play/engine/ 文件夹完整）`));
			document.head.appendChild(s);
		});
	}
	function b64ToBytes(b64) {
		const bin = atob(b64);
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	}
	/** 浏览器是否支持 WASM SIMD（MediaPipe 这一版只带了 SIMD 版运行时）。 */
	function hasWasmSimd() {
		try {
			return WebAssembly.validate(new Uint8Array([
				0,
				97,
				115,
				109,
				1,
				0,
				0,
				0,
				1,
				5,
				1,
				96,
				0,
				1,
				123,
				3,
				2,
				1,
				0,
				10,
				10,
				1,
				8,
				0,
				65,
				0,
				253,
				15,
				253,
				98,
				11
			]));
		} catch {
			return false;
		}
	}
	var fileset = null;
	var modelBytes = null;
	/**
	* 加载引擎文件并创建姿态估计器（先试 GPU，失败回退 CPU）。
	* @param {(msg:string)=>void} onStatus 进度提示
	*/
	async function createPoseEngine(onStatus = () => {}) {
		if (!hasWasmSimd()) throw new Error("这个浏览器不支持 WebAssembly SIMD，姿态引擎无法运行。请换用较新版本的 Edge / Chrome / Safari。");
		if (!fileset) {
			onStatus("正在加载姿态引擎（约 22 MB，只在第一次需要几秒）…");
			await loadScript("engine/vision_wasm_internal.js");
			window.__MP_MODULE_FACTORY = self.ModuleFactory;
			await loadScript("engine/wasm_b64.js");
			await loadScript("engine/model_b64.js");
			if (!window.__MP_WASM_B64 || !window.__MP_MODEL_B64) throw new Error("引擎数据文件不完整（engine/wasm_b64.js 或 model_b64.js）。");
			onStatus("正在解码模型…");
			const wasm = b64ToBytes(window.__MP_WASM_B64);
			modelBytes = b64ToBytes(window.__MP_MODEL_B64);
			window.__MP_WASM_B64 = null;
			window.__MP_MODEL_B64 = null;
			const wasmUrl = URL.createObjectURL(new Blob([wasm], { type: "application/wasm" }));
			fileset = {
				wasmLoaderPath: "data:text/javascript," + encodeURIComponent("self.ModuleFactory=window.__MP_MODULE_FACTORY;"),
				wasmBinaryPath: wasmUrl
			};
		}
		const make = (delegate) => Zc.createFromOptions(fileset, {
			baseOptions: {
				modelAssetBuffer: modelBytes.slice(),
				delegate
			},
			runningMode: "VIDEO",
			numPoses: 1
		});
		onStatus("正在初始化姿态模型…");
		let landmarker = null;
		let delegate = "GPU";
		let note = "";
		try {
			landmarker = await make("GPU");
		} catch (e) {
			console.warn("[pose] GPU 后端初始化失败，回退 CPU：", e);
			delegate = "CPU";
			note = "GPU 不可用，已改用 CPU";
			landmarker = await make("CPU");
		}
		return {
			delegate,
			note,
			detect: (video, ts) => landmarker.detectForVideo(video, ts),
			close: () => {
				try {
					landmarker.close();
				} catch {}
			}
		};
	}
	/** 退出时释放解码后的大数组。 */
	function releaseEngineData() {
		if (fileset) URL.revokeObjectURL(fileset.wasmBinaryPath);
		fileset = null;
		modelBytes = null;
		window.__MP_MODULE_FACTORY = null;
	}
	/** 33 个关键点之间的连线（来自 MediaPipe 官方定义）。 */
	var POSE_CONNECTIONS = Zc.POSE_CONNECTIONS;
	//#endregion
	//#region play_src/mobile.js
	/**
	* mobile.js —— 手机竖屏通用工具（不含任何规则逻辑；打包进 play/app.js）。
	*
	*   detect(opts)             触屏 + 宽度 ≤ 980px + 竖屏 → body.touchp；触屏横屏（宽 ≤ 980px）→ body.touchl；
	*                            任何触屏 → body.touch。窗口尺寸 / 方向变化时自动更新，变化后调 opts.onChange(state)。
	*   menu(btn, box)           ☰ 菜单：点按钮开关，点菜单项 / 点外面 / Esc 关闭。
	*   sheets(closeBtn, onChange) 全屏面板控制器：open('panel') 给 body 加 sheet-panel，close() 去掉；
	*                            共用一个「返回」按钮；返回 {open, close, toggle, current}。
	*   rotateHint(okBtn)        横屏提示：点「仍然横屏继续」给 body 加 rot-ok；转回竖屏时自动清掉。
	*   pressFeedback(root, sel) 按下时给元素加 .pressed 并轻微振动（navigator.vibrate，失败静默）；
	*                            抬起 / 取消 / 窗口失焦时全部清掉。
	*   guard(root, opts)        防误触：触屏下禁止长按菜单、iOS 捏合手势；窗口失焦、页面隐藏、
	*                            所有手指离开时调 opts.onReset()。
	*   destroy()                退出时解绑全部监听。
	*
	* 所有样式挂在 style.css 的 body.touchp / body.touchl / body.sheet-* 下面。
	*/
	var state = {
		touch: false,
		touchp: false,
		touchl: false,
		maxWidth: 980
	};
	var bound = [];
	var changeCbs = [];
	function on(el, ev, fn, opt) {
		el.addEventListener(ev, fn, opt);
		bound.push([
			el,
			ev,
			fn,
			opt
		]);
	}
	function vibrate(ms) {
		try {
			if (navigator.vibrate) navigator.vibrate(ms);
		} catch {}
	}
	function mm(q) {
		try {
			return !!(window.matchMedia && window.matchMedia(q).matches);
		} catch {
			return false;
		}
	}
	/** “触屏设备” = 主要输入是手指：粗指针，或者有触摸点但没有悬停能力。
	*  带触摸屏的笔记本（有鼠标、能悬停）不算，仍用键鼠布局和键盘说明。 */
	function isTouchDevice() {
		const capable = navigator.maxTouchPoints > 0 || "ontouchstart" in window;
		return mm("(pointer: coarse)") || capable && !mm("(hover: hover)");
	}
	function classify() {
		const w = window.innerWidth;
		const h = window.innerHeight;
		const touch = isTouchDevice();
		const portrait = h >= w;
		const next = {
			touch,
			touchp: touch && portrait && w <= state.maxWidth,
			touchl: touch && !portrait && w <= state.maxWidth
		};
		const changed = next.touch !== state.touch || next.touchp !== state.touchp || next.touchl !== state.touchl;
		Object.assign(state, next);
		const b = document.body;
		b.classList.toggle("touch", state.touch);
		b.classList.toggle("touchp", state.touchp);
		b.classList.toggle("touchl", state.touchl);
		if (!state.touchl) b.classList.remove("rot-ok");
		return changed;
	}
	function detect(opts = {}) {
		if (opts.maxWidth) state.maxWidth = opts.maxWidth;
		if (opts.onChange) changeCbs.push(opts.onChange);
		classify();
		let t = null;
		const relayout = () => {
			clearTimeout(t);
			t = setTimeout(() => {
				if (classify()) changeCbs.forEach((cb) => cb(state));
			}, 80);
		};
		on(window, "resize", relayout);
		on(window, "orientationchange", relayout);
		return state;
	}
	function menu(btn, box) {
		if (!btn || !box) return null;
		const set = (open) => {
			box.hidden = !open;
			btn.setAttribute("aria-expanded", open ? "true" : "false");
		};
		on(btn, "click", (e) => {
			e.stopPropagation();
			set(box.hidden);
		});
		on(box, "click", (e) => {
			if (e.target.closest("button, a")) set(false);
		});
		on(document, "click", (e) => {
			if (!box.hidden && !box.contains(e.target) && e.target !== btn) set(false);
		});
		on(document, "keydown", (e) => {
			if (e.key === "Escape" && !box.hidden) set(false);
		});
		return {
			open: () => set(true),
			close: () => set(false),
			isOpen: () => !box.hidden
		};
	}
	function sheets(closeBtn, onChange) {
		let cur = null;
		const apply = (name) => {
			if (cur) document.body.classList.remove("sheet-" + cur);
			cur = name || null;
			if (cur) document.body.classList.add("sheet-" + cur);
			if (closeBtn) closeBtn.hidden = !cur;
			if (onChange) onChange(cur);
		};
		if (closeBtn) on(closeBtn, "click", () => apply(null));
		on(document, "keydown", (e) => {
			if (e.key === "Escape" && cur) apply(null);
		});
		return {
			open: (name) => apply(name),
			close: () => {
				if (cur) apply(null);
			},
			toggle: (name) => apply(cur === name ? null : name),
			current: () => cur
		};
	}
	function rotateHint(okBtn) {
		if (okBtn) on(okBtn, "click", () => document.body.classList.add("rot-ok"));
	}
	function clearPressed() {
		document.querySelectorAll(".pressed").forEach((el) => el.classList.remove("pressed"));
	}
	function pressFeedback(rootEl, selector) {
		if (!rootEl) return;
		on(rootEl, "pointerdown", (e) => {
			const t = e.target.closest ? e.target.closest(selector) : null;
			if (!t || t.disabled) return;
			t.classList.add("pressed");
			if (e.pointerType === "touch") vibrate(8);
		});
		on(rootEl, "pointerup", clearPressed);
		on(rootEl, "pointercancel", clearPressed);
		on(window, "blur", clearPressed);
	}
	function guard(rootEl, opts = {}) {
		const reset = () => {
			clearPressed();
			if (opts.onReset) opts.onReset();
		};
		on(rootEl, "contextmenu", (e) => {
			if (state.touch) e.preventDefault();
		});
		on(document, "gesturestart", (e) => e.preventDefault());
		on(rootEl, "touchend", (e) => {
			if (!e.touches || e.touches.length === 0) clearPressed();
		});
		on(rootEl, "touchcancel", reset);
		on(window, "blur", reset);
		on(document, "visibilitychange", () => {
			if (document.hidden) reset();
		});
	}
	function destroy() {
		bound.forEach(([el, ev, fn, opt]) => el.removeEventListener(ev, fn, opt));
		bound = [];
		changeCbs = [];
	}
	//#endregion
	//#region play_src/app.js
	/**
	* app.js —— 离线网页版（play/）的编排层。
	*
	* 三个模式（顶部标签切换）：
	*   看示例   —— 播放程序合成的骨架片段（不是真人录制），规则引擎在浏览器里实时运行；
	*   我来练   —— 打开摄像头，MediaPipe 姿态网络出 33 个关键点，同一套规则判定；
	*   练习任务 —— 看示例 + 任务清单，逐项打勾。
	*
	* 规则（计数 / 纠错）、话术、语音、历史、肌肉图全部复用 src/ 里的原模块；
	* 这里只负责界面、回放、右栏「规则引擎面板」和 file:// 兼容的引擎加载（poseEngine.js）。
	*/
	var $ = (id) => document.getElementById(id);
	var CREDITS = window.CREDITS || {};
	var EX = {
		squat: {
			create: createSquatExercise,
			name: "深蹲",
			metricName: "膝关节角度",
			unit: "°",
			yMin: 60,
			yMax: 185,
			fmt: (v) => `${Math.round(v)}°`,
			states: {
				up: "站立",
				down: "下蹲"
			}
		},
		jumpingJack: {
			create: createJumpingJackExercise,
			name: "开合跳",
			metricName: "踝距 / 肩宽",
			unit: "×",
			yMin: .3,
			yMax: 2.2,
			fmt: (v) => `${v.toFixed(2)}×`,
			states: {
				closed: "并拢",
				open: "张开"
			}
		}
	};
	var LM_NAMES = [
		"鼻子",
		"左眼内",
		"左眼",
		"左眼外",
		"右眼内",
		"右眼",
		"右眼外",
		"左耳",
		"右耳",
		"嘴左",
		"嘴右",
		"左肩",
		"右肩",
		"左肘",
		"右肘",
		"左腕",
		"右腕",
		"左小指",
		"右小指",
		"左食指",
		"右食指",
		"左拇指",
		"右拇指",
		"左髋",
		"右髋",
		"左膝",
		"右膝",
		"左踝",
		"右踝",
		"左脚跟",
		"右脚跟",
		"左脚尖",
		"右脚尖"
	];
	var LM_GROUPS = [
		{
			name: "头部",
			from: 0,
			to: 10
		},
		{
			name: "上肢",
			from: 11,
			to: 22
		},
		{
			name: "下肢",
			from: 23,
			to: 32
		}
	];
	var VIS_THRESHOLD = .5;
	var TASKS = [
		{
			id: "t1",
			text: "看完「深蹲 · 标准」：5 次全部打 ✓（标准档）",
			go: () => goClip("squat_good", "standard")
		},
		{
			id: "t2",
			text: "在深蹲最低点按暂停（空格），读出右栏的膝角",
			go: () => goClip("squat_good")
		},
		{
			id: "t3",
			text: "把严格度调到「严格」，让「深蹲 · 标准」出现「不够深」",
			go: () => goClip("squat_good")
		},
		{
			id: "t4",
			text: "在开合跳片段里找到触发「手臂没举过头顶」的那一段",
			go: () => goClip("jj_good")
		},
		{
			id: "t5",
			text: "播放「脚出了画面」，看右下角关键点可见度，想想为什么一次也不算",
			go: () => goClip("squat_cropped")
		},
		{
			id: "t6",
			text: "切到「自定义」，拖一个滑块，看同一片段的判定怎么变",
			go: () => {
				setPreset("custom");
				$("fineTune").open = true;
			}
		},
		{
			id: "t7",
			text: "（有摄像头时）切到「我来练」，自己完成 3 次深蹲或开合跳",
			go: () => setMode("live")
		}
	];
	var S = {
		mode: "watch",
		exercise: "squat",
		preset: "standard",
		custom: {
			squat: null,
			jumpingJack: null
		},
		clipId: "squat_good",
		frameIdx: -1,
		playing: true,
		speed: 1,
		autoNext: true,
		acc: 0,
		ex: null,
		lastR: null,
		lastLm: null,
		lastRep: null,
		samples: [],
		marks: [],
		stats: {
			total: 0,
			good: 0,
			cueCounts: {},
			metrics: []
		},
		silent: false,
		clipEndedAt: null,
		camOn: false,
		engine: null,
		stream: null,
		liveT0: 0,
		lastVideoTime: -1,
		rafId: 0,
		lastTs: 0,
		timers: /* @__PURE__ */ new Set(),
		exited: false,
		llmReqId: 0,
		muscleTick: 0
	};
	var speaker;
	var muscleView;
	var sheet = null;
	var doneTasks = loadTasks();
	function later(fn, ms) {
		const id = setTimeout(() => {
			S.timers.delete(id);
			fn();
		}, ms);
		S.timers.add(id);
		return id;
	}
	function store(key, val) {
		try {
			if (val === void 0) return localStorage.getItem(key);
			localStorage.setItem(key, val);
		} catch {}
		return null;
	}
	function loadTasks() {
		try {
			const arr = JSON.parse(localStorage.getItem("poseCoach.tasks.v1") || "[]");
			return new Set(Array.isArray(arr) ? arr : []);
		} catch {
			return /* @__PURE__ */ new Set();
		}
	}
	function esc(s) {
		return String(s).replace(/[&<>"]/g, (c) => ({
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			"\"": "&quot;"
		})[c]);
	}
	function thresholds() {
		return thresholdsFor(S.exercise, S.preset, S.custom[S.exercise]);
	}
	function newExercise() {
		S.ex = EX[S.exercise].create(thresholds());
		S.lastR = null;
		S.lastRep = null;
		S.samples = [];
		S.marks = [];
		S.stats = {
			total: 0,
			good: 0,
			cueCounts: {},
			metrics: []
		};
	}
	/** 一帧关键点进规则引擎，更新状态；返回规则结果。 */
	function processFrame(lm, t) {
		S.lastLm = lm;
		const r = S.ex.update(lm);
		S.lastR = r;
		S.samples.push({
			t,
			v: r.ready ? r.metricValue : null,
			phase: r.phase
		});
		if (S.samples.length > 2400) S.samples.splice(0, S.samples.length - 2400);
		if (r.repCompleted && r.lastRep) {
			const rep = r.lastRep;
			S.lastRep = {
				...rep,
				thresholds: { ...S.ex.thresholds }
			};
			S.marks.push({
				t,
				good: rep.good
			});
			S.stats.total += 1;
			if (rep.good) S.stats.good += 1;
			for (const c of rep.cues) S.stats.cueCounts[c] = (S.stats.cueCounts[c] ?? 0) + 1;
			if (rep.metric != null) S.stats.metrics.push(rep.metric);
			if (!S.silent) onRepCompleted(rep);
		}
		return r;
	}
	function onRepCompleted(rep) {
		const fb = repFeedback(rep);
		setCaption(fb.text, fb.good);
		appendLog(fb.text, fb.good);
		speaker.speak(String(rep.index), { skippable: true });
		if (!rep.good) speaker.speak(cueSpeechText(rep.cues), { dedupeKey: rep.cues.join(",") });
		if (S.mode !== "live") {
			if (S.clipId === "squat_good" && S.preset === "strict" && rep.cues.includes("shallow")) completeTask("t3");
			if (rep.cues.includes("arms_low")) completeTask("t4");
		} else if (S.stats.total >= 3) completeTask("t7");
		renderVerdict();
	}
	function currentClip() {
		return generateClip(S.clipId);
	}
	function loadClip(id, { keepPlaying = true } = {}) {
		const meta = getClipMeta(id);
		S.clipId = id;
		if (meta.exercise !== S.exercise) {
			S.exercise = meta.exercise;
			$("exerciseSel").value = S.exercise;
			renderPresetUI();
		}
		$("clipSel").value = id;
		$("clipNote").textContent = meta.note;
		S.frameIdx = -1;
		S.acc = 0;
		S.clipEndedAt = null;
		newExercise();
		clearLog();
		setCaption("", null);
		S.playing = keepPlaying;
		updatePlayBtn();
		applyExerciseUI();
		stepTo(0);
	}
	/** 从头重算到第 idx 帧（拖进度条、改阈值时用）：规则是确定的，重算结果与一路播过来完全一样。 */
	function resimTo(idx) {
		const clip = currentClip();
		idx = Math.max(0, Math.min(idx, clip.frames.length - 1));
		newExercise();
		S.silent = true;
		for (let i = 0; i <= idx; i++) processFrame(clip.frames[i], i / 30);
		S.silent = false;
		S.frameIdx = idx;
		S.clipEndedAt = null;
		if (S.clipId === "squat_good" && S.preset === "strict" && S.stats.cueCounts.shallow) completeTask("t3");
		if (S.stats.cueCounts.arms_low) completeTask("t4");
		rebuildLogFromStats();
		renderAll();
	}
	/** 向前推进到第 idx 帧（逐帧处理，不跳帧，保证状态机正确）。 */
	function stepTo(idx) {
		const clip = currentClip();
		idx = Math.min(idx, clip.frames.length - 1);
		while (S.frameIdx < idx) {
			S.frameIdx += 1;
			processFrame(clip.frames[S.frameIdx], S.frameIdx / 30);
		}
		if (S.frameIdx >= clip.frames.length - 1 && S.clipEndedAt == null) onClipEnd();
		renderAll();
	}
	function onClipEnd() {
		S.clipEndedAt = performance.now();
		const meta = getClipMeta(S.clipId);
		const txt = S.stats.total === 0 ? `这一段一次也没有计数：规则需要的关键点可见度不够（看右下角），宁可不计数也不乱判。` : setSummary({
			exercise: EX[S.exercise].name,
			total: S.stats.total,
			goodCount: S.stats.good
		});
		setCaption(txt, S.stats.total > 0 && S.stats.good === S.stats.total);
		appendLog("【本段小结】" + txt, null);
		if (S.clipId === "squat_good" && S.preset === "standard" && S.stats.total === 5 && S.stats.good === 5) completeTask("t1");
		if (S.clipId === "squat_cropped") completeTask("t5");
		if (S.autoNext && S.playing && S.mode !== "live") later(() => {
			if (S.exited || S.mode === "live" || !S.playing || S.clipId !== meta.id) return;
			const same = CLIPS.filter((c) => c.exercise === meta.exercise);
			const next = same[(same.findIndex((c) => c.id === meta.id) + 1) % same.length];
			loadClip(next.id);
		}, 2200);
		else {
			S.playing = false;
			updatePlayBtn();
		}
	}
	function tickWatch(dt) {
		if (!S.playing) return;
		const clip = currentClip();
		if (S.frameIdx >= clip.frames.length - 1) return;
		S.acc += dt * 30 * S.speed;
		const n = Math.floor(S.acc);
		if (n > 0) {
			S.acc -= n;
			stepTo(S.frameIdx + n);
		}
	}
	function togglePlay() {
		if (S.mode === "live") return;
		const clip = currentClip();
		if (!S.playing && S.frameIdx >= clip.frames.length - 1) {
			loadClip(S.clipId);
			return;
		}
		S.playing = !S.playing;
		updatePlayBtn();
		if (!S.playing && S.exercise === "squat" && S.lastR?.ready && S.lastR.metricValue < 110) completeTask("t2");
	}
	function stepFrame(delta) {
		if (S.mode === "live") return;
		S.playing = false;
		updatePlayBtn();
		if (delta > 0) stepTo(S.frameIdx + 1);
		else resimTo(S.frameIdx - 1);
		if (S.exercise === "squat" && S.lastR?.ready && S.lastR.metricValue < 110) completeTask("t2");
	}
	function goClip(id, preset) {
		if (S.mode === "live") setMode("tasks");
		if (preset) setPreset(preset, { silent: true });
		loadClip(id);
	}
	async function startCamera() {
		const btn = $("camBtn");
		btn.disabled = true;
		try {
			if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(/* @__PURE__ */ new Error("这个页面拿不到摄像头接口。"), { name: "NoApi" });
			showStageHint("正在请求摄像头权限…（浏览器会弹出询问，请点「允许」）");
			const stream = await navigator.mediaDevices.getUserMedia({
				video: {
					width: 640,
					height: 480,
					facingMode: "user"
				},
				audio: false
			});
			if (S.exited || S.mode !== "live") {
				stream.getTracks().forEach((t) => t.stop());
				return;
			}
			S.stream = stream;
			const video = $("video");
			video.srcObject = stream;
			await video.play();
			setStageSize(video.videoWidth || 640, video.videoHeight || 480);
			if (!S.engine) {
				S.engine = await createPoseEngine((m) => showStageHint(m));
				$("engineInfo").textContent = `姿态网络推理后端：${S.engine.delegate === "GPU" ? "GPU（WebGL2）" : "CPU"}${S.engine.note ? "（" + S.engine.note + "）" : ""}`;
			}
			if (S.exited || S.mode !== "live") return stopCamera();
			S.camOn = true;
			S.liveT0 = performance.now();
			S.lastVideoTime = -1;
			newExercise();
			clearLog();
			hideStageHint();
			setCaption("正对摄像头，后退到脚踝也在画面里，然后开始做。", null);
		} catch (err) {
			console.warn(err);
			stopCamera();
			showStageHint(describeCamError(err), true);
		} finally {
			btn.disabled = false;
			updateCamBtn();
		}
	}
	function stopCamera() {
		if (S.camOn) finishSet();
		S.camOn = false;
		if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
		S.stream = null;
		const video = $("video");
		if (video) video.srcObject = null;
		setStageSize(640, 480);
		updateCamBtn();
	}
	/** 主画面的内部分辨率和宽高比：示例片段固定 4:3；摄像头按视频真实尺寸（手机竖屏前置摄像头多是竖的）。 */
	function setStageSize(w, h) {
		const cv = $("stage");
		if (cv.width !== w || cv.height !== h) {
			cv.width = w;
			cv.height = h;
		}
		$("stageWrap").style.setProperty("--stage-ar", `${w} / ${h}`);
	}
	function describeCamError(err) {
		const online = CREDITS.PAGES_URL ? `\n也可以改用在线版（https）：${CREDITS.PAGES_URL}` : "";
		switch (err?.name) {
			case "NotAllowedError":
			case "SecurityError": return "摄像头没有被允许：请点地址栏左侧的摄像头图标，改成「允许」后再点「开摄像头」。" + online;
			case "NotFoundError":
			case "OverconstrainedError": return "没有找到可用的摄像头。没有摄像头也没关系，「看示例」和「练习任务」都能完整使用。";
			case "NotReadableError":
			case "AbortError": return "摄像头被别的程序占用了（会议软件、其他标签页），关掉它们后再试。";
			case "NoApi": return "这个浏览器在双击打开的本地页面里不提供摄像头（Safari 可能如此）。" + online;
			default: return "无法启动：" + (err?.message || String(err)) + online;
		}
	}
	function tickLive() {
		if (!S.camOn || !S.engine) return;
		const video = $("video");
		if (video.readyState < 2 || video.currentTime === S.lastVideoTime) return;
		S.lastVideoTime = video.currentTime;
		const lm = S.engine.detect(video, performance.now()).landmarks?.[0] ?? null;
		const t = (performance.now() - S.liveT0) / 1e3;
		if (lm) processFrame(lm, t);
		else {
			S.lastLm = null;
			S.lastR = null;
			S.samples.push({
				t,
				v: null,
				phase: null
			});
		}
		renderAll();
	}
	function finishSet() {
		if (S.stats.total === 0) return;
		addRecord({
			time: (/* @__PURE__ */ new Date()).toISOString(),
			exercise: EX[S.exercise].name,
			total: S.stats.total,
			good: S.stats.good,
			cues: { ...S.stats.cueCounts }
		});
		renderHistory();
		const summary = setSummary({
			exercise: EX[S.exercise].name,
			total: S.stats.total,
			goodCount: S.stats.good
		});
		appendLog("【本组小结】" + summary, null);
		setCaption(summary, null);
		if ($("llmToggle").checked) {
			const id = ++S.llmReqId;
			const metricAvg = S.stats.metrics.length ? (S.stats.metrics.reduce((a, b) => a + b, 0) / S.stats.metrics.length).toFixed(1) : null;
			$("llmStatus").textContent = "正在请求本机大模型点评…";
			llmSetSummary({
				exercise: EX[S.exercise].name,
				total: S.stats.total,
				goodCount: S.stats.good,
				cueCounts: S.stats.cueCounts,
				metricLabel: S.ex.repMetricLabel,
				metricAvg
			}).then((text) => {
				if (S.exited || id !== S.llmReqId) return;
				if (text) {
					appendLog("【本机大模型点评】" + text, null);
					$("llmStatus").textContent = "已收到本机大模型点评。";
					speaker.speak(text, { dedupeKey: "llm-summary" });
				} else $("llmStatus").textContent = "没连上本机大模型（或超时 8 秒），已使用模板话术。";
			});
		}
		S.stats = {
			total: 0,
			good: 0,
			cueCounts: {},
			metrics: []
		};
		S.ex.reset();
	}
	function frame(ts) {
		if (S.exited) return;
		const dt = S.lastTs ? Math.min((ts - S.lastTs) / 1e3, .1) : 0;
		S.lastTs = ts;
		if (S.mode === "live") tickLive();
		else tickWatch(dt);
		drawStage();
		S.rafId = requestAnimationFrame(frame);
	}
	function drawStage() {
		const cv = $("stage");
		const ctx = cv.getContext("2d");
		const w = cv.width;
		const h = cv.height;
		ctx.save();
		if (S.mode === "live" && S.camOn) {
			ctx.translate(w, 0);
			ctx.scale(-1, 1);
			ctx.drawImage($("video"), 0, 0, w, h);
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.fillStyle = "rgba(15,23,42,0.35)";
			ctx.fillRect(0, 0, w, h);
		} else {
			const g = ctx.createLinearGradient(0, 0, 0, h);
			g.addColorStop(0, "#111c33");
			g.addColorStop(1, "#0b1222");
			ctx.fillStyle = g;
			ctx.fillRect(0, 0, w, h);
			if (S.mode !== "live") {
				ctx.strokeStyle = "rgba(148,163,184,0.25)";
				ctx.setLineDash([6, 8]);
				ctx.beginPath();
				ctx.moveTo(40, h * .93);
				ctx.lineTo(w - 40, h * .93);
				ctx.stroke();
				ctx.setLineDash([]);
			}
		}
		ctx.restore();
		const lm = S.mode === "live" && !S.camOn ? null : S.lastLm;
		if (lm) drawSkeleton(ctx, lm, w, h, S.ex?.required ?? []);
	}
	function drawSkeleton(ctx, lm, w, h, required) {
		const P = (p) => [(1 - p.x) * w, p.y * h];
		const req = new Set(required);
		ctx.lineCap = "round";
		for (const { start, end } of POSE_CONNECTIONS) {
			const a = lm[start];
			const b = lm[end];
			if (!a || !b) continue;
			const low = (a.visibility ?? 1) < VIS_THRESHOLD || (b.visibility ?? 1) < VIS_THRESHOLD;
			ctx.strokeStyle = low ? "rgba(34,211,238,0.25)" : "#22d3ee";
			ctx.lineWidth = low ? 2 : 4;
			ctx.setLineDash(low ? [4, 6] : []);
			const [x1, y1] = P(a);
			const [x2, y2] = P(b);
			ctx.beginPath();
			ctx.moveTo(x1, y1);
			ctx.lineTo(x2, y2);
			ctx.stroke();
		}
		ctx.setLineDash([]);
		lm.forEach((p, i) => {
			const [x, y] = P(p);
			const low = (p.visibility ?? 1) < VIS_THRESHOLD;
			ctx.beginPath();
			ctx.arc(x, y, req.has(i) ? 6 : 4, 0, Math.PI * 2);
			ctx.fillStyle = low ? "rgba(248,250,252,0.3)" : "#f8fafc";
			ctx.fill();
			if (req.has(i)) {
				ctx.lineWidth = 2;
				ctx.strokeStyle = low ? "#f87171" : "#fbbf24";
				ctx.stroke();
			}
		});
		const r = S.lastR;
		if (!r?.ready) return;
		ctx.font = "bold 18px system-ui, sans-serif";
		ctx.textAlign = "center";
		if (S.exercise === "squat") {
			const [xa, ya] = P(lm[25]);
			const [xb, yb] = P(lm[26]);
			label(ctx, `膝角（两膝平均）${Math.round(r.metricValue)}°`, (xa + xb) / 2, Math.max(ya, yb) + 34);
		} else {
			const [x1, y1] = P(lm[27]);
			const [x2, y2] = P(lm[28]);
			ctx.strokeStyle = "#fbbf24";
			ctx.lineWidth = 2;
			ctx.setLineDash([5, 5]);
			ctx.beginPath();
			ctx.moveTo(x1, y1 + 22);
			ctx.lineTo(x2, y2 + 22);
			ctx.stroke();
			const [s1x, s1y] = P(lm[11]);
			const [s2x, s2y] = P(lm[12]);
			ctx.beginPath();
			ctx.moveTo(s1x, s1y - 14);
			ctx.lineTo(s2x, s2y - 14);
			ctx.stroke();
			ctx.setLineDash([]);
			label(ctx, `踝距 ÷ 肩宽 = ${r.metricValue.toFixed(2)}`, Math.min(w - 110, Math.max(x1, x2) + 110), Math.min(h - 60, y1 + 26));
		}
	}
	function label(ctx, text, x, y) {
		const m = ctx.measureText(text);
		ctx.fillStyle = "rgba(15,23,42,0.8)";
		ctx.fillRect(x - m.width / 2 - 6, y - 17, m.width + 12, 24);
		ctx.fillStyle = "#fde68a";
		ctx.fillText(text, x, y);
	}
	function renderAll() {
		const r = S.lastR;
		$("countNum").textContent = String(r?.count ?? 0);
		const states = EX[S.exercise].states;
		$("phaseTag").textContent = r ? r.ready ? states[r.phase] : "关键点不全 · 暂停判定" : "—";
		$("phaseTag").classList.toggle("warn", !!r && !r.ready);
		renderMobStats(r);
		drawCurve();
		renderFsm();
		renderLiveTrackers();
		renderVis();
		if (S.mode !== "live") renderProgress();
		if (++S.muscleTick % 4 === 0) muscleView.highlight(S.ex.muscleGroups, r?.ready ? r.depthRatio : 0);
	}
	function curveWindow() {
		return 10;
	}
	function drawCurve() {
		const cv = $("curve");
		const dpr = window.devicePixelRatio || 1;
		const cw = cv.clientWidth;
		const ch = cv.clientHeight;
		if (!cw || !ch) return;
		if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
			cv.width = Math.round(cw * dpr);
			cv.height = Math.round(ch * dpr);
		}
		const ctx = cv.getContext("2d");
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, cw, ch);
		const E = EX[S.exercise];
		const T = S.ex.thresholds;
		const padL = 44;
		const padR = 128;
		const padT = 10;
		const padB = 22;
		const pw = cw - padL - padR;
		const ph = ch - padT - padB;
		const tNow = S.samples.length ? S.samples[S.samples.length - 1].t : 0;
		const tMin = Math.max(0, tNow - curveWindow());
		const tMax = Math.max(curveWindow(), tNow);
		const X = (t) => padL + (t - (tMax - curveWindow())) / curveWindow() * pw;
		const Y = (v) => padT + (1 - (v - E.yMin) / (E.yMax - E.yMin)) * ph;
		const downPhase = S.exercise === "squat" ? "down" : "open";
		ctx.fillStyle = "rgba(34,211,238,0.07)";
		let segStart = null;
		for (const s of S.samples) {
			if (s.t < tMin) continue;
			if (s.phase === downPhase && segStart == null) segStart = s.t;
			if (s.phase !== downPhase && segStart != null) {
				ctx.fillRect(X(segStart), padT, X(s.t) - X(segStart), ph);
				segStart = null;
			}
		}
		if (segStart != null) ctx.fillRect(X(segStart), padT, X(tNow) - X(segStart), ph);
		ctx.strokeStyle = "rgba(148,163,184,0.15)";
		ctx.lineWidth = 1;
		ctx.fillStyle = "#94a3b8";
		ctx.font = "11px system-ui, sans-serif";
		ctx.textAlign = "right";
		const ticks = S.exercise === "squat" ? [
			60,
			90,
			120,
			150,
			180
		] : [
			.5,
			1,
			1.5,
			2
		];
		for (const v of ticks) {
			ctx.beginPath();
			ctx.moveTo(padL, Y(v));
			ctx.lineTo(padL + pw, Y(v));
			ctx.stroke();
			ctx.fillText(S.exercise === "squat" ? `${v}°` : `${v}`, padL - 6, Y(v) + 4);
		}
		ctx.textAlign = "left";
		ctx.fillText(`最近 ${curveWindow()} 秒 →`, padL, ch - 6);
		const lines = S.exercise === "squat" ? [
			{
				v: T.upAngle,
				text: `站起线 ${T.upAngle}°`,
				color: "#94a3b8"
			},
			{
				v: T.downAngle,
				text: `下蹲线 ${T.downAngle}°`,
				color: "#94a3b8"
			},
			{
				v: T.shallowAngle,
				text: `蹲深线 ${T.shallowAngle}°`,
				color: "#fbbf24"
			}
		] : [
			{
				v: T.openRatio,
				text: `张开线 ${T.openRatio.toFixed(2)}`,
				color: "#94a3b8"
			},
			{
				v: T.closeRatio,
				text: `并拢线 ${T.closeRatio.toFixed(2)}`,
				color: "#94a3b8"
			},
			{
				v: T.fullSpread,
				text: `到位线 ${T.fullSpread.toFixed(2)}`,
				color: "#fbbf24"
			}
		];
		const labelYs = [];
		for (const L of lines) {
			ctx.strokeStyle = L.color;
			ctx.setLineDash([6, 4]);
			ctx.beginPath();
			ctx.moveTo(padL, Y(L.v));
			ctx.lineTo(padL + pw, Y(L.v));
			ctx.stroke();
			ctx.setLineDash([]);
			let ly = Y(L.v) + 4;
			for (const o of labelYs) if (Math.abs(o - ly) < 13) ly = o + 13;
			labelYs.push(ly);
			ctx.fillStyle = L.color;
			ctx.fillText(L.text, padL + pw + 6, ly);
		}
		ctx.strokeStyle = "#22d3ee";
		ctx.lineWidth = 2;
		ctx.beginPath();
		let pen = false;
		for (const s of S.samples) {
			if (s.t < tMin) continue;
			if (s.v == null) {
				pen = false;
				continue;
			}
			const v = Math.max(E.yMin, Math.min(E.yMax, s.v));
			if (!pen) ctx.moveTo(X(s.t), Y(v));
			else ctx.lineTo(X(s.t), Y(v));
			pen = true;
		}
		ctx.stroke();
		ctx.font = "bold 14px system-ui, sans-serif";
		ctx.textAlign = "center";
		for (const m of S.marks) {
			if (m.t < tMin) continue;
			ctx.fillStyle = m.good ? "#4ade80" : "#f87171";
			ctx.fillText(m.good ? "✓" : "✗", X(m.t), 24);
		}
		const last = S.samples[S.samples.length - 1];
		if (last && last.v != null) {
			const v = Math.max(E.yMin, Math.min(E.yMax, last.v));
			ctx.fillStyle = "#22d3ee";
			ctx.beginPath();
			ctx.arc(X(last.t), Y(v), 4, 0, Math.PI * 2);
			ctx.fill();
		}
		if (curveHover != null) {
			const t = tMax - curveWindow() + (curveHover - padL) / pw * curveWindow();
			let best = null;
			for (const s of S.samples) if (best == null || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
			if (best && curveHover >= padL && curveHover <= padL + pw) {
				ctx.strokeStyle = "rgba(226,232,240,0.5)";
				ctx.beginPath();
				ctx.moveTo(X(best.t), padT);
				ctx.lineTo(X(best.t), padT + ph);
				ctx.stroke();
				const txt = best.v == null ? "关键点不全" : `${E.metricName} ${E.fmt(best.v)}`;
				ctx.font = "12px system-ui, sans-serif";
				const tw = ctx.measureText(txt).width + 12;
				const bx = Math.min(X(best.t) + 8, padL + pw - tw);
				ctx.fillStyle = "rgba(15,23,42,0.92)";
				ctx.fillRect(bx, 30, tw, 22);
				ctx.fillStyle = "#e2e8f0";
				ctx.textAlign = "left";
				ctx.fillText(txt, bx + 6, 45);
			}
		}
		$("curveValue").textContent = last && last.v != null ? E.fmt(last.v) : "—";
	}
	var curveHover = null;
	function renderFsm() {
		const E = EX[S.exercise];
		const T = S.ex.thresholds;
		const isSquat = S.exercise === "squat";
		const [a, b] = isSquat ? ["up", "down"] : ["closed", "open"];
		const phase = S.lastR?.ready ? S.lastR.phase : null;
		const key = `${S.exercise}|${JSON.stringify(T)}`;
		const box = $("fsm");
		if (box.dataset.key !== key) {
			box.dataset.key = key;
			const go = isSquat ? `膝角 &lt; ${T.downAngle}°` : `踝距/肩宽 &gt; ${T.openRatio.toFixed(2)}`;
			const back = isSquat ? `膝角 &gt; ${T.upAngle}° → 计数 +1` : `踝距/肩宽 &lt; ${T.closeRatio.toFixed(2)} → 计数 +1`;
			box.innerHTML = `
      <div class="fsm-state" data-state="${a}">${E.states[a]}</div>
      <div class="fsm-arrows">
        <div class="fsm-arrow fwd"><span>${go}</span><i>→</i></div>
        <div class="fsm-arrow back"><i>←</i><span>${back}</span></div>
      </div>
      <div class="fsm-state" data-state="${b}">${E.states[b]}</div>`;
		}
		box.querySelectorAll(".fsm-state").forEach((el) => el.classList.toggle("on", el.dataset.state === phase));
		box.classList.toggle("paused", !S.lastR?.ready);
	}
	function renderLiveTrackers() {
		const r = S.lastR;
		const el = $("fsmLive");
		if (!r) return el.textContent = "等待关键点…";
		if (!r.ready) return el.textContent = "关键点可见度不够，状态机暂停，不计数也不判错。";
		if (S.exercise === "squat") el.textContent = r.phase === "down" ? `本次下蹲中：最低膝角 ${Math.round(r.repMinKneeAngle)}°，最小膝距/踝距 ${r.repMinValgusRatio.toFixed(2)}` : `站立中：膝角 ${Math.round(r.metricValue)}°，膝距/踝距 ${r.valgusRatio.toFixed(2)}`;
		else el.textContent = r.phase === "open" ? `本次张开中：峰值 ${r.repMaxSpread.toFixed(2)}×，双腕${r.repArmsUpSeen ? "已" : "还没"}高过鼻子` : `并拢中：踝距/肩宽 ${r.metricValue.toFixed(2)}×，双腕${r.armsUp ? "高于" : "低于"}鼻子`;
	}
	function renderVerdict() {
		const el = $("verdict");
		const rep = S.lastRep;
		if (!rep) {
			el.innerHTML = `<p class="muted">还没有完成的动作。每完成一次，这里逐条列出规则用到的数值和阈值。</p>`;
			return;
		}
		const T = rep.thresholds;
		const rows = S.exercise === "squat" ? [{
			rule: "蹲得够深",
			val: `最低膝角 ${rep.minKneeAngle}°`,
			need: `≤ ${T.shallowAngle}°`,
			ok: !rep.cues.includes("shallow"),
			bad: "不够深"
		}, {
			rule: "膝盖不内扣",
			val: `膝距/踝距 ${rep.minValgusRatio.toFixed(2)}`,
			need: `≥ ${T.valgusRatio.toFixed(2)}`,
			ok: !rep.cues.includes("valgus"),
			bad: "膝盖内扣"
		}] : [{
			rule: "手举过头顶",
			val: `双腕曾高于鼻子：${rep.armsUp ? "是" : "否"}`,
			need: "必须为「是」",
			ok: !rep.cues.includes("arms_low"),
			bad: "手没举过头"
		}, {
			rule: "腿跳开到位",
			val: `张开峰值 ${rep.maxSpread.toFixed(2)}×`,
			need: `≥ ${T.fullSpread.toFixed(2)}×`,
			ok: !rep.cues.includes("narrow"),
			bad: "张开不足"
		}];
		const fb = repFeedback(rep);
		el.innerHTML = `
    <div class="verdict-head ${rep.good ? "good" : "warn"}">第 ${rep.index} 次：${rep.good ? "✓ 标准" : "✗ 需要改进"}</div>
    <table class="verdict-table">
      <tr><th>规则</th><th>测到的值</th><th>阈值</th><th>结果</th></tr>
      ${rows.map((r) => `<tr><td>${r.rule}</td><td>${esc(r.val)}</td><td>${esc(r.need)}</td><td class="${r.ok ? "good" : "warn"}">${r.ok ? "✓ 通过" : "✗ " + r.bad}</td></tr>`).join("")}
    </table>
    <p class="verdict-say">教练话术（模板）：${esc(fb.text.replace(/^第 \d+ 次：/, ""))}</p>`;
	}
	function buildVis() {
		const el = $("visGrid");
		el.innerHTML = LM_GROUPS.map((g) => `<div class="vis-group"><div class="vis-gname">${g.name}<small>${g.to - g.from + 1} 点</small></div><div class="vis-bars">${Array.from({ length: g.to - g.from + 1 }, (_, k) => {
			const i = g.from + k;
			return `<div class="vis-bar" data-i="${i}" title="${i} ${LM_NAMES[i]}"><span class="vis-fill"></span><em>${LM_NAMES[i]}</em></div>`;
		}).join("")}</div></div>`).join("");
	}
	function renderVis() {
		const lm = S.mode === "live" && !S.camOn ? null : S.lastLm;
		const req = new Set(S.ex?.required ?? []);
		let reqOk = 0;
		document.querySelectorAll("#visGrid .vis-bar").forEach((bar) => {
			const i = Number(bar.dataset.i);
			const v = lm?.[i]?.visibility ?? 0;
			const fill = bar.firstElementChild;
			fill.style.height = `${Math.round(v * 100)}%`;
			bar.classList.toggle("req", req.has(i));
			bar.classList.toggle("low", v < VIS_THRESHOLD);
			if (req.has(i) && v >= VIS_THRESHOLD) reqOk++;
		});
		$("visSummary").textContent = lm ? `规则需要的 ${req.size} 个点（黄框）里有 ${reqOk} 个可见度 ≥ ${VIS_THRESHOLD}${reqOk === req.size ? "，可以判定。" : "，不够：暂停判定。"}` : "还没有关键点。";
	}
	function setCaption(text, good) {
		const el = $("caption");
		el.textContent = text;
		el.classList.toggle("hidden", !text);
		el.classList.toggle("good", good === true);
		el.classList.toggle("warn", good === false);
	}
	function appendLog(text, good) {
		const li = document.createElement("li");
		li.textContent = text;
		if (good === true) li.className = "good";
		if (good === false) li.className = "warn";
		$("log").prepend(li);
		while ($("log").children.length > 30) $("log").lastChild.remove();
	}
	function clearLog() {
		$("log").innerHTML = "";
	}
	function rebuildLogFromStats() {
		clearLog();
		if (S.lastRep) {
			const fb = repFeedback(S.lastRep);
			setCaption(fb.text, fb.good);
		} else setCaption("", null);
		renderVerdict();
	}
	function showStageHint(text, isError = false) {
		const el = $("stageHint");
		el.textContent = text;
		el.classList.remove("hidden");
		el.classList.toggle("error", isError);
	}
	function hideStageHint() {
		$("stageHint").classList.add("hidden");
	}
	function renderProgress() {
		const n = currentClip().frames.length;
		const pr = $("progress");
		pr.max = String(n - 1);
		if (document.activeElement !== pr) pr.value = String(Math.max(0, S.frameIdx));
		$("timeText").textContent = `${(Math.max(0, S.frameIdx) / 30).toFixed(1)} / ${((n - 1) / 30).toFixed(1)} 秒`;
	}
	function updatePlayBtn() {
		$("playBtn").textContent = S.playing ? "⏸ 暂停" : "▶ 播放";
		updateMobBar();
	}
	function updateCamBtn() {
		$("camBtn").textContent = S.camOn ? "■ 关摄像头" : "● 开摄像头";
		$("resetBtn").disabled = !S.camOn;
		updateMobBar();
	}
	/** 手机竖屏：主画面下方的大按钮文字（电脑上这些元素不显示，但状态照样维护）。 */
	function updateMobBar() {
		if (S.mode === "live") {
			$("mStart").textContent = S.camOn ? "■ 关摄像头" : "● 开摄像头";
			$("mReplay").textContent = "看示例";
		} else {
			$("mStart").textContent = S.playing ? "⏸ 暂停" : "▶ 开始";
			$("mReplay").textContent = "⏮ 回放";
		}
		$("mSwap").textContent = S.exercise === "squat" ? "换开合跳" : "换深蹲";
	}
	/** 手机竖屏：计数 / 状态大字。 */
	function renderMobStats(r) {
		const E = EX[S.exercise];
		$("mCount").textContent = String(r?.count ?? 0);
		const line = $("mPhase").parentElement;
		if (S.mode === "live" && !S.camOn) {
			$("mPhase").textContent = E.name;
			$("mMetric").textContent = "摄像头未开";
			line.classList.remove("warn");
		} else if (!r) {
			$("mPhase").textContent = E.name;
			$("mMetric").textContent = "等待关键点…";
			line.classList.remove("warn");
		} else if (!r.ready) {
			$("mPhase").textContent = "关键点不全";
			$("mMetric").textContent = "暂停判定";
			line.classList.add("warn");
		} else {
			$("mPhase").textContent = `${E.name} · ${E.states[r.phase]}`;
			$("mMetric").textContent = `${E.metricName} ${E.fmt(r.metricValue)}`;
			line.classList.remove("warn");
		}
		const v = $("mVerdict");
		const cap = $("caption");
		v.textContent = cap.classList.contains("hidden") ? "" : cap.textContent;
		v.classList.toggle("good", cap.classList.contains("good"));
		v.classList.toggle("warn", cap.classList.contains("warn"));
	}
	function renderHistory() {
		const records = loadHistory();
		const agg = aggregate(records);
		$("historyTotals").textContent = agg.sets === 0 ? "暂无记录。在「我来练」里练完一组（点「结束本组」或关摄像头）会自动记一条，只存在这台电脑的浏览器里。" : `累计 ${agg.sets} 组 / ${agg.reps} 次，标准 ${agg.goodReps} 次（${Math.round(agg.goodReps / Math.max(agg.reps, 1) * 100)}%）`;
		$("historyList").innerHTML = records.slice(0, 10).map((r) => {
			const t = new Date(r.time);
			return `<li>${`${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`} · ${esc(r.exercise)} ${r.total} 次（标准 ${r.good}）</li>`;
		}).join("");
	}
	function renderPresetUI() {
		document.querySelectorAll("#presetBtns button").forEach((b) => b.classList.toggle("on", b.dataset.preset === S.preset));
		$("presetDesc").textContent = PRESET_DESC[S.exercise][S.preset];
		const T = thresholds();
		$("sliders").innerHTML = SLIDERS[S.exercise].map((s) => `<label class="slider"><span>${s.label}</span>
        <input type="range" min="${s.min}" max="${s.max}" step="${s.step}" value="${T[s.key]}" data-key="${s.key}">
        <b>${fmtSlider(s, T[s.key])}</b></label>`).join("");
	}
	function fmtSlider(s, v) {
		return s.step >= 1 ? `${Math.round(v)}${s.unit}` : `${Number(v).toFixed(2)}${s.unit}`;
	}
	function setPreset(p, { silent = false } = {}) {
		if (p === "custom" && !S.custom[S.exercise]) S.custom[S.exercise] = { ...thresholdsFor(S.exercise, S.preset) };
		S.preset = p;
		renderPresetUI();
		if (!silent) applyThresholdChange();
	}
	function applyThresholdChange() {
		if (S.mode === "live") {
			finishSet();
			newExercise();
			renderVerdict();
		} else resimTo(S.frameIdx);
	}
	function setMode(mode) {
		if (mode === S.mode) return;
		const prev = S.mode;
		S.mode = mode;
		document.body.dataset.mode = mode;
		document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === mode));
		if (prev === "live") {
			stopCamera();
			hideStageHint();
			loadClip(S.clipId);
		}
		updateMobBar();
		if (mode === "live") {
			S.playing = false;
			newExercise();
			clearLog();
			setCaption("", null);
			S.lastLm = null;
			S.lastR = null;
			renderVerdict();
			showStageHint("点下方「● 开摄像头」开始。\n正对摄像头，后退到从头到脚踝都在画面里。\n摄像头画面只在这台电脑上处理，不会上传。");
			updateCamBtn();
			renderAll();
		}
		renderTasks();
	}
	function applyExerciseUI() {
		const E = EX[S.exercise];
		$("curveTitle").textContent = `${E.metricName}（实时）`;
		$("visHint").textContent = S.exercise === "squat" ? "深蹲只用髋、膝、踝 6 个点（黄框）。" : "开合跳用鼻、肩、腕、踝 7 个点（黄框）。";
		muscleView.highlight(S.ex.muscleGroups, 0);
		renderVerdict();
	}
	function onExerciseChange(kind) {
		if (S.mode === "live") {
			finishSet();
			S.exercise = kind;
			renderPresetUI();
			newExercise();
			applyExerciseUI();
			return;
		}
		const first = CLIPS.find((c) => c.exercise === kind);
		S.exercise = kind;
		renderPresetUI();
		loadClip(first.id);
		updateMobBar();
	}
	function completeTask(id) {
		if (doneTasks.has(id)) return;
		doneTasks.add(id);
		store("poseCoach.tasks.v1", JSON.stringify([...doneTasks]));
		renderTasks();
		const t = TASKS.find((x) => x.id === id);
		if (t && S.mode === "tasks") toast(`✓ 完成任务：${t.text}`);
	}
	function renderTasks() {
		const el = $("taskList");
		el.innerHTML = TASKS.map((t, i) => `<li class="${doneTasks.has(t.id) ? "done" : ""}"><span class="tick">${doneTasks.has(t.id) ? "✓" : i + 1}</span><span class="ttext">${t.text}</span><button class="mini" data-task="${t.id}">去做</button></li>`).join("");
		$("taskCount").textContent = `${doneTasks.size} / ${TASKS.length}`;
	}
	function toast(text) {
		const el = $("toast");
		el.textContent = text;
		el.classList.add("show");
		later(() => el.classList.remove("show"), 2600);
	}
	var miniPlayers = /* @__PURE__ */ new Map();
	function startMini(canvas, clipId) {
		const clip = generateClip(clipId);
		const st = {
			i: 0,
			raf: 0
		};
		const ctx = canvas.getContext("2d");
		const draw = () => {
			if (S.exited) return;
			st.i = (st.i + 1) % clip.frames.length;
			const lm = clip.frames[st.i];
			const w = canvas.width;
			const h = canvas.height;
			ctx.fillStyle = "#0b1222";
			ctx.fillRect(0, 0, w, h);
			ctx.strokeStyle = "#4ade80";
			ctx.setLineDash([5, 4]);
			ctx.strokeRect(6, 6, w - 12, h - 12);
			ctx.setLineDash([]);
			ctx.strokeStyle = "#22d3ee";
			ctx.lineWidth = 3;
			for (const { start, end } of POSE_CONNECTIONS) {
				const a = lm[start];
				const b = lm[end];
				ctx.beginPath();
				ctx.moveTo((1 - a.x) * w, a.y * h);
				ctx.lineTo((1 - b.x) * w, b.y * h);
				ctx.stroke();
			}
			st.raf = requestAnimationFrame(draw);
		};
		st.raf = requestAnimationFrame(draw);
		miniPlayers.set(canvas, st);
	}
	function stopMini(canvas) {
		const st = miniPlayers.get(canvas);
		if (st) cancelAnimationFrame(st.raf);
		miniPlayers.delete(canvas);
	}
	function openHelp() {
		$("helpModal").classList.remove("hidden");
		startMini($("helpMini"), S.exercise === "squat" ? "squat_good" : "jj_good");
	}
	function closeHelp() {
		$("helpModal").classList.add("hidden");
		stopMini($("helpMini"));
		if (store("poseCoach.helpSeen") !== "1" && S.mode !== "live") loadClip(S.clipId);
		store("poseCoach.helpSeen", "1");
	}
	function bindTooltips() {
		const tip = $("tooltip");
		let mini = null;
		document.querySelectorAll("[data-tip]").forEach((el) => {
			el.addEventListener("mouseenter", () => {
				const anim = el.dataset.tipAnim;
				tip.innerHTML = `${anim ? "<canvas width=\"150\" height=\"112\" class=\"tip-mini\"></canvas>" : ""}<div>${esc(el.dataset.tip)}</div>`;
				tip.classList.add("show");
				const r = el.getBoundingClientRect();
				const tw = tip.offsetWidth;
				tip.style.left = `${Math.max(8, Math.min(window.innerWidth - tw - 8, r.left + r.width / 2 - tw / 2))}px`;
				const below = r.bottom + 8;
				tip.style.top = `${below + tip.offsetHeight > window.innerHeight ? r.top - tip.offsetHeight - 8 : below}px`;
				if (anim) {
					mini = tip.querySelector("canvas");
					startMini(mini, anim);
				}
			});
			el.addEventListener("mouseleave", () => {
				tip.classList.remove("show");
				if (mini) stopMini(mini);
				mini = null;
			});
		});
	}
	function exitApp() {
		if (S.exited) return;
		S.exited = true;
		cancelAnimationFrame(S.rafId);
		for (const id of S.timers) clearTimeout(id);
		S.timers.clear();
		for (const c of [...miniPlayers.keys()]) stopMini(c);
		try {
			speechSynthesis.cancel();
		} catch {}
		if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
		S.stream = null;
		if (S.engine) S.engine.close();
		S.engine = null;
		releaseEngineData();
		window.removeEventListener("keydown", onKey);
		window.removeEventListener("resize", onResize);
		destroy();
		S.samples = [];
		S.marks = [];
		S.lastLm = null;
		try {
			window.close();
		} catch {}
		setTimeout(() => {
			document.body.innerHTML = "<div class=\"endpage\"><h1>已停止运行</h1><p>所有计算都已结束，可以直接关闭这个标签页。</p></div>";
			document.body.dataset.mode = "ended";
		}, 150);
	}
	function onKey(e) {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) {
			if (e.key !== "Escape") return;
		}
		if (!$("helpModal").classList.contains("hidden")) {
			if (e.key === "Escape" || e.key === "h" || e.key === "H") closeHelp();
			return;
		}
		if (e.key === "h" || e.key === "H") openHelp();
		else if (e.key === " ") {
			e.preventDefault();
			togglePlay();
		} else if (e.key === "ArrowRight") stepFrame(1);
		else if (e.key === "ArrowLeft") stepFrame(-1);
		else if (e.key === "b" || e.key === "B") {
			$("bigScreen").checked = !$("bigScreen").checked;
			applyBigScreen();
		}
	}
	function onResize() {
		drawCurve();
	}
	function applyBigScreen() {
		document.body.classList.toggle("big", $("bigScreen").checked);
		store("poseCoach.big", $("bigScreen").checked ? "1" : "0");
		requestAnimationFrame(drawCurve);
	}
	function bind() {
		document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setMode(t.dataset.mode)));
		$("exerciseSel").addEventListener("change", (e) => onExerciseChange(e.target.value));
		$("clipSel").addEventListener("change", (e) => loadClip(e.target.value));
		$("playBtn").addEventListener("click", togglePlay);
		$("stepBtn").addEventListener("click", () => stepFrame(1));
		$("backBtn").addEventListener("click", () => stepFrame(-1));
		$("restartBtn").addEventListener("click", () => loadClip(S.clipId));
		document.querySelectorAll("#speedBtns button").forEach((b) => b.addEventListener("click", () => {
			S.speed = Number(b.dataset.speed);
			document.querySelectorAll("#speedBtns button").forEach((x) => x.classList.toggle("on", x === b));
		}));
		$("autoNext").addEventListener("change", (e) => S.autoNext = e.target.checked);
		$("progress").addEventListener("input", (e) => {
			S.playing = false;
			updatePlayBtn();
			resimTo(Number(e.target.value));
		});
		document.querySelectorAll("#presetBtns button").forEach((b) => b.addEventListener("click", () => setPreset(b.dataset.preset)));
		$("sliders").addEventListener("input", (e) => {
			const inp = e.target;
			if (!(inp instanceof HTMLInputElement)) return;
			if (S.preset !== "custom") setPreset("custom", { silent: true });
			S.custom[S.exercise] = {
				...S.custom[S.exercise],
				[inp.dataset.key]: Number(inp.value)
			};
			const def = SLIDERS[S.exercise].find((s) => s.key === inp.dataset.key);
			inp.nextElementSibling.textContent = fmtSlider(def, Number(inp.value));
			document.querySelectorAll("#presetBtns button").forEach((b) => b.classList.toggle("on", b.dataset.preset === "custom"));
			$("presetDesc").textContent = PRESET_DESC[S.exercise].custom;
			completeTask("t6");
			applyThresholdChange();
		});
		$("camBtn").addEventListener("click", () => S.camOn ? stopCamera() : startCamera());
		$("resetBtn").addEventListener("click", () => {
			finishSet();
			newExercise();
			renderVerdict();
		});
		$("clearHistoryBtn").addEventListener("click", () => {
			clearHistory();
			renderHistory();
		});
		$("speechToggle").addEventListener("change", (e) => speaker.setEnabled(e.target.checked));
		$("llmToggle").addEventListener("change", (e) => {
			$("llmStatus").textContent = e.target.checked ? "已打开：每组结束时尝试请求本机 Ollama（需另外安装并允许跨域，见 README）；连不上就用模板话术。" : "关闭中：组总结使用模板话术。";
		});
		$("helpBtn").addEventListener("click", openHelp);
		$("helpClose").addEventListener("click", closeHelp);
		$("exitBtn").addEventListener("click", exitApp);
		$("bigScreen").addEventListener("change", applyBigScreen);
		$("taskList").addEventListener("click", (e) => {
			const b = e.target.closest("button[data-task]");
			if (b) TASKS.find((t) => t.id === b.dataset.task).go();
		});
		$("taskReset").addEventListener("click", () => {
			doneTasks.clear();
			store("poseCoach.tasks.v1", "[]");
			renderTasks();
		});
		const cv = $("curve");
		cv.addEventListener("mousemove", (e) => {
			curveHover = e.offsetX;
			drawCurve();
		});
		cv.addEventListener("mouseleave", () => {
			curveHover = null;
			drawCurve();
		});
		window.addEventListener("keydown", onKey);
		window.addEventListener("resize", onResize);
		bindTooltips();
		bindMobile();
	}
	/** 手机竖屏：大按钮、☰ 菜单、全屏面板、横屏提示、防误触（mobile.js）。电脑上这些元素不显示。 */
	function bindMobile() {
		detect({ onChange: () => requestAnimationFrame(drawCurve) });
		menu($("menuBtn"), $("menu"));
		sheet = sheets($("panelClose"), () => requestAnimationFrame(drawCurve));
		rotateHint($("rotateOk"));
		pressFeedback($("mobBar"), ".mbtn");
		guard(document.body, {});
		$("mStart").addEventListener("click", () => {
			if (S.mode === "live") S.camOn ? stopCamera() : startCamera();
			else togglePlay();
		});
		$("mSwap").addEventListener("click", () => {
			const next = S.exercise === "squat" ? "jumpingJack" : "squat";
			$("exerciseSel").value = next;
			onExerciseChange(next);
			updateMobBar();
		});
		$("mReplay").addEventListener("click", () => {
			if (S.mode === "live") setMode("watch");
			else loadClip(S.clipId);
		});
		$("mPanel").addEventListener("click", () => sheet.toggle("panel"));
		$("menuHelp").addEventListener("click", openHelp);
		$("menuPanel").addEventListener("click", () => sheet.open("panel"));
		$("menuSettings").addEventListener("click", () => {
			$("moreSettings").open = true;
			$("moreSettings").scrollIntoView({
				block: "start",
				behavior: "smooth"
			});
		});
		$("menuExit").addEventListener("click", exitApp);
	}
	function init() {
		speaker = createSpeaker();
		speaker.setEnabled(false);
		if (!speaker.supported) {
			$("speechToggle").disabled = true;
			$("speechLabel").textContent = "语音播报（这个浏览器不支持）";
		}
		muscleView = createMuscleView($("muscleFront"), $("muscleBack"));
		$("clipSel").innerHTML = CLIPS.map((c) => `<option value="${c.id}">${c.name}</option>`).join("");
		$("presetBtns").innerHTML = PRESET_ORDER.map((p) => `<button data-preset="${p}">${PRESET_LABELS[p]}</button>`).join("");
		buildVis();
		const f = CREDITS;
		$("footer").innerHTML = [
			f.SERIES_NAME_ZH ? `属于「${esc(f.SERIES_NAME_ZH)}」系列` : "",
			f.AUTHOR ? `作者 ${esc(f.AUTHOR)}${f.AUTHOR_EMAIL ? "（" + esc(f.AUTHOR_EMAIL) + "）" : ""}` : "",
			f.UNIVERSITY_EN ? esc(f.UNIVERSITY_EN) : "",
			f.UNIVERSITY_KO ? esc(f.UNIVERSITY_KO) : "",
			"代码 MIT · 文档 CC BY 4.0",
			"姿态模型 MediaPipe Pose Landmarker（Apache-2.0）· 肌肉图 body-muscles（Apache-2.0）"
		].filter(Boolean).join(" · ");
		if (store("poseCoach.big") === "1") {
			$("bigScreen").checked = true;
			document.body.classList.add("big");
		}
		document.body.dataset.mode = "watch";
		bind();
		renderPresetUI();
		renderHistory();
		renderTasks();
		updateCamBtn();
		loadClip("squat_good");
		if (store("poseCoach.helpSeen") !== "1") openHelp();
		S.rafId = requestAnimationFrame(frame);
	}
	window.__poseCoach = {
		state: () => ({
			mode: S.mode,
			exercise: S.exercise,
			preset: S.preset,
			clipId: S.clipId,
			frameIdx: S.frameIdx,
			playing: S.playing,
			count: S.lastR?.count ?? 0,
			stats: { ...S.stats },
			lastRep: S.lastRep,
			camOn: S.camOn,
			engine: S.engine ? S.engine.delegate : null,
			exited: S.exited,
			touchp: document.body.classList.contains("touchp"),
			sheet: sheet ? sheet.current() : null,
			stage: $("stage") ? {
				w: $("stage").width,
				h: $("stage").height
			} : null
		}),
		seekEnd: () => {
			S.playing = false;
			stepTo(currentClip().frames.length - 1);
		},
		restart: () => loadClip(S.clipId, { keepPlaying: false })
	};
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
	else init();
	//#endregion
})();
