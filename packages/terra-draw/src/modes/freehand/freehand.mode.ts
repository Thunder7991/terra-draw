import {
	TerraDrawMouseEvent,
	TerraDrawAdapterStyling,
	TerraDrawKeyboardEvent,
	HexColorStyling,
	NumericStyling,
	Cursor,
	UpdateTypes,
	COMMON_PROPERTIES,
	Z_INDEX,
} from "../../common";
import { Polygon } from "geojson";

import {
	BaseModeOptions,
	CustomStyling,
	TerraDrawBaseDrawMode,
} from "../base.mode";
import { getDefaultStyling } from "../../util/styling";
import {
	FeatureId,
	GeoJSONStoreFeatures,
	StoreValidation,
} from "../../store/store";
import { cartesianDistance } from "../../geometry/measure/pixel-distance";
import { ValidatePolygonFeature } from "../../validations/polygon.validation";
import { ensureRightHandRule } from "../../geometry/ensure-right-hand-rule";

type TerraDrawFreehandModeKeyEvents = {
	cancel: KeyboardEvent["key"] | null;
	finish: KeyboardEvent["key"] | null;
};

const defaultKeyEvents = { cancel: "Escape", finish: "Enter" };

type FreehandPolygonStyling = {
	fillColor: HexColorStyling;
	outlineColor: HexColorStyling;
	outlineWidth: NumericStyling;
	fillOpacity: NumericStyling;
	closingPointColor: HexColorStyling;
	closingPointWidth: NumericStyling;
	closingPointOutlineColor: HexColorStyling;
	closingPointOutlineWidth: NumericStyling;
};

interface Cursors {
	start?: Cursor;
	close?: Cursor;
}

const defaultCursors = {
	start: "crosshair",
	close: "pointer",
} as Required<Cursors>;

interface TerraDrawFreehandModeOptions<T extends CustomStyling>
	extends BaseModeOptions<T> {
	minDistance?: number;
	preventPointsNearClose?: boolean;
	autoClose?: boolean;
	autoCloseTimeout?: number;
	keyEvents?: TerraDrawFreehandModeKeyEvents | null;
	cursors?: Cursors;
}

export class TerraDrawFreehandMode extends TerraDrawBaseDrawMode<FreehandPolygonStyling> {
	mode = "freehand" as const;

	private startingClick = false;
	private currentId: FeatureId | undefined;
	private closingPointId: FeatureId | undefined;
	private minDistance: number = 20;
	private keyEvents: TerraDrawFreehandModeKeyEvents = defaultKeyEvents;
	private cursors: Required<Cursors> = defaultCursors;
	private preventPointsNearClose: boolean = true;
	private autoClose: boolean = false;
	private autoCloseTimeout = 500;
	private hasLeftStartingPoint = false;
	private preventNewFeature = false;

	constructor(options?: TerraDrawFreehandModeOptions<FreehandPolygonStyling>) {
		super(options, true);
		this.updateOptions(options);
	}

	public updateOptions(
		options?: TerraDrawFreehandModeOptions<FreehandPolygonStyling> | undefined,
	): void {
		super.updateOptions(options);

		if (options?.minDistance) {
			this.minDistance = options.minDistance;
		}

		if (options?.preventPointsNearClose !== undefined) {
			this.preventPointsNearClose = options.preventPointsNearClose;
		}

		if (options?.autoClose !== undefined) {
			this.autoClose = options.autoClose;
		}

		if (options?.autoCloseTimeout) {
			this.autoCloseTimeout = options.autoCloseTimeout;
		}

		if (options?.keyEvents === null) {
			this.keyEvents = { cancel: null, finish: null };
		} else if (options?.keyEvents) {
			this.keyEvents = { ...this.keyEvents, ...options.keyEvents };
		}

		if (options?.cursors) {
			this.cursors = { ...this.cursors, ...options.cursors };
		}
	}

	private close() {
		if (this.currentId === undefined) {
			return;
		}

		// Fix right hand rule if necessary
		if (this.currentId) {
			const correctedGeometry = ensureRightHandRule(
				this.store.getGeometryCopy<Polygon>(this.currentId),
			);
			if (correctedGeometry) {
				this.store.updateGeometry([
					{ id: this.currentId, geometry: correctedGeometry },
				]);
			}
			this.store.updateProperty([
				{
					id: this.currentId,
					property: COMMON_PROPERTIES.CURRENTLY_DRAWING,
					value: undefined,
				},
			]);
		}

		const finishedId = this.currentId;

		if (this.validate && finishedId) {
			const currentGeometry = this.store.getGeometryCopy<Polygon>(finishedId);

			const validationResult = this.validate(
				{
					type: "Feature",
					id: finishedId,
					geometry: currentGeometry,
					properties: {},
				},
				{
					project: this.project,
					unproject: this.unproject,
					coordinatePrecision: this.coordinatePrecision,
					updateType: UpdateTypes.Finish,
				},
			);

			if (!validationResult.valid) {
				return;
			}
		}

		if (this.closingPointId) {
			this.store.delete([this.closingPointId]);
		}
		this.startingClick = false;
		this.currentId = undefined;
		this.closingPointId = undefined;
		this.hasLeftStartingPoint = false;
		// Go back to started state
		if (this.state === "drawing") {
			this.setStarted();
		}

		// Ensure that any listerers are triggered with the main created geometry
		this.onFinish(finishedId, { mode: this.mode, action: "draw" });
	}

	/** @internal */
	start() {
		this.setStarted();
		this.setCursor(this.cursors.start);
	}

	/** @internal */
	stop() {
		this.cleanUp();
		this.setStopped();
		this.setCursor("unset");
	}

	/** @internal */
	onMouseMove(event: TerraDrawMouseEvent) {
		if (this.currentId === undefined || this.startingClick === false) {
			this.setCursor(this.cursors.start);
			return;
		}

		const currentLineGeometry = this.store.getGeometryCopy<Polygon>(
			this.currentId,
		);

		const previousIndex = currentLineGeometry.coordinates[0].length - 2;
		const [previousLng, previousLat] =
			currentLineGeometry.coordinates[0][previousIndex];
		const { x, y } = this.project(previousLng, previousLat);
		const distance = cartesianDistance(
			{ x, y },
			{ x: event.containerX, y: event.containerY },
		);

		const [closingLng, closingLat] = currentLineGeometry.coordinates[0][0];
		const { x: closingX, y: closingY } = this.project(closingLng, closingLat);
		const closingDistance = cartesianDistance(
			{ x: closingX, y: closingY },
			{ x: event.containerX, y: event.containerY },
		);

		if (closingDistance < this.pointerDistance) {
			// We only want to close the polygon if the users cursor has left the
			// region of the starting point
			if (this.autoClose && this.hasLeftStartingPoint) {
				// If we have an autoCloseTimeout, we want to prevent new features
				// being created by accidental clicks for a short period of time
				this.preventNewFeature = true;
				setTimeout(() => {
					this.preventNewFeature = false;
				}, this.autoCloseTimeout);

				this.close();
			}

			this.setCursor(this.cursors.close);

			// We want to prohibit drawing new points at or around the closing
			// point as it can be non user friendly
			if (this.preventPointsNearClose) {
				return;
			}
		} else {
			this.hasLeftStartingPoint = true;
			this.setCursor(this.cursors.start);
		}

		// The cusor must have moved a minimum distance
		// before we add another coordinate
		if (distance < this.minDistance) {
			return;
		}

		currentLineGeometry.coordinates[0].pop();

		const newGeometry = {
			type: "Polygon",
			coordinates: [
				[
					...currentLineGeometry.coordinates[0],
					[event.lng, event.lat],
					currentLineGeometry.coordinates[0][0],
				],
			],
		} as Polygon;

		if (this.validate) {
			const validationResult = this.validate(
				{
					type: "Feature",
					id: this.currentId,
					geometry: newGeometry,
					properties: {},
				},
				{
					project: this.project,
					unproject: this.unproject,
					coordinatePrecision: this.coordinatePrecision,
					updateType: UpdateTypes.Provisional,
				},
			);

			if (!validationResult.valid) {
				return;
			}
		}

		this.store.updateGeometry([
			{
				id: this.currentId,
				geometry: newGeometry,
			},
		]);
	}

	/** @internal */
	onClick(event: TerraDrawMouseEvent) {
		if (
			(event.button === "right" &&
				this.allowPointerEvent(this.pointerEvents.rightClick, event)) ||
			(event.button === "left" &&
				this.allowPointerEvent(this.pointerEvents.leftClick, event)) ||
			(event.isContextMenu &&
				this.allowPointerEvent(this.pointerEvents.contextMenu, event))
		) {
			if (this.preventNewFeature) {
				return;
			}

			if (this.startingClick === false) {
				const [createdId, closingPointId] = this.store.create([
					{
						geometry: {
							type: "Polygon",
							coordinates: [
								[
									[event.lng, event.lat],
									[event.lng, event.lat],
									[event.lng, event.lat],
									[event.lng, event.lat],
								],
							],
						},
						properties: {
							mode: this.mode,
							[COMMON_PROPERTIES.CURRENTLY_DRAWING]: true,
						},
					},
					{
						geometry: {
							type: "Point",
							coordinates: [event.lng, event.lat],
						},
						properties: {
							mode: this.mode,
							[COMMON_PROPERTIES.CLOSING_POINT]: true,
						},
					},
				]);

				this.currentId = createdId;
				this.closingPointId = closingPointId;
				this.startingClick = true;

				// We could already be in drawing due to updating the existing polygon
				// via afterFeatureUpdated
				if (this.state !== "drawing") {
					this.setDrawing();
				}

				return;
			}

			this.close();
		}
	}

	/** @internal */
	onKeyDown() {}

	/** @internal */
	onKeyUp(event: TerraDrawKeyboardEvent) {
		if (event.key === this.keyEvents.cancel) {
			this.cleanUp();
		} else if (event.key === this.keyEvents.finish) {
			if (this.startingClick === true) {
				this.close();
			}
		}
	}

	/** @internal */
	onDragStart() {}

	/** @internal */
	onDrag() {}

	/** @internal */
	onDragEnd() {}

	/** @internal */
	cleanUp() {
		const cleanUpId = this.currentId;
		const cleanUpClosingPointId = this.closingPointId;

		this.closingPointId = undefined;
		this.currentId = undefined;
		this.startingClick = false;
		if (this.state === "drawing") {
			this.setStarted();
		}

		try {
			if (cleanUpId !== undefined) {
				this.store.delete([cleanUpId]);
			}
			if (cleanUpClosingPointId !== undefined) {
				this.store.delete([cleanUpClosingPointId]);
			}
		} catch (error) {}
	}

	/** @internal */
	styleFeature(feature: GeoJSONStoreFeatures): TerraDrawAdapterStyling {
		const styles = { ...getDefaultStyling() };

		if (
			feature.type === "Feature" &&
			feature.geometry.type === "Polygon" &&
			feature.properties.mode === this.mode
		) {
			styles.polygonFillColor = this.getHexColorStylingValue(
				this.styles.fillColor,
				styles.polygonFillColor,
				feature,
			);

			styles.polygonOutlineColor = this.getHexColorStylingValue(
				this.styles.outlineColor,
				styles.polygonOutlineColor,
				feature,
			);

			styles.polygonOutlineWidth = this.getNumericStylingValue(
				this.styles.outlineWidth,
				styles.polygonOutlineWidth,
				feature,
			);

			styles.polygonFillOpacity = this.getNumericStylingValue(
				this.styles.fillOpacity,
				styles.polygonFillOpacity,
				feature,
			);

			styles.zIndex = Z_INDEX.LAYER_ONE;

			return styles;
		} else if (
			feature.type === "Feature" &&
			feature.geometry.type === "Point" &&
			feature.properties.mode === this.mode
		) {
			styles.pointWidth = this.getNumericStylingValue(
				this.styles.closingPointWidth,
				styles.pointWidth,
				feature,
			);

			styles.pointColor = this.getHexColorStylingValue(
				this.styles.closingPointColor,
				styles.pointColor,
				feature,
			);

			styles.pointOutlineColor = this.getHexColorStylingValue(
				this.styles.closingPointOutlineColor,
				styles.pointOutlineColor,
				feature,
			);

			styles.pointOutlineWidth = this.getNumericStylingValue(
				this.styles.closingPointOutlineWidth,
				2,
				feature,
			);

			styles.zIndex = Z_INDEX.LAYER_FIVE;

			return styles;
		}

		return styles;
	}

	validateFeature(feature: unknown): StoreValidation {
		return this.validateModeFeature(feature, (baseValidatedFeature) =>
			ValidatePolygonFeature(baseValidatedFeature, this.coordinatePrecision),
		);
	}

	afterFeatureUpdated(feature: GeoJSONStoreFeatures) {
		// NOTE: This handles the case we are currently drawing a polygon
		// We need to reset the drawing state because it is very complicated (impossible?)
		// to recover the drawing state after a feature update
		if (this.currentId === feature.id) {
			if (this.closingPointId) {
				this.store.delete([this.closingPointId]);
			}
			this.startingClick = false;
			this.currentId = undefined;
			this.closingPointId = undefined;
			this.hasLeftStartingPoint = false;
		}
	}
}
