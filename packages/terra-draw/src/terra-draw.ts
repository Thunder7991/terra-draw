/**
 * @module terra-draw
 */
import {
	TerraDrawAdapter,
	TerraDrawAdapterStyling,
	GetLngLatFromEvent,
	Project,
	SetCursor,
	TerraDrawChanges,
	TerraDrawStylingFunction,
	Unproject,
	HexColor,
	TerraDrawKeyboardEvent,
	TerraDrawMouseEvent,
	SELECT_PROPERTIES,
	OnFinishContext,
	COMMON_PROPERTIES,
	TerraDrawGeoJSONStore,
	OnChangeContext,
} from "./common";
import {
	ModeTypes,
	TerraDrawBaseDrawMode,
	TerraDrawBaseSelectMode,
} from "./modes/base.mode";
import { TerraDrawCircleMode } from "./modes/circle/circle.mode";
import { TerraDrawFreehandMode } from "./modes/freehand/freehand.mode";
import { TerraDrawLineStringMode } from "./modes/linestring/linestring.mode";
import { TerraDrawPointMode } from "./modes/point/point.mode";
import { TerraDrawPolygonMode } from "./modes/polygon/polygon.mode";
import { TerraDrawRectangleMode } from "./modes/rectangle/rectangle.mode";
import { TerraDrawRenderMode } from "./modes/render/render.mode";
import { TerraDrawSelectMode } from "./modes/select/select.mode";
import { TerraDrawStaticMode } from "./modes/static/static.mode";
import {
	BBoxPolygon,
	FeatureId,
	GeoJSONStore,
	GeoJSONStoreFeatures,
	GeoJSONStoreGeometries,
	IdStrategy,
	StoreChangeHandler,
	StoreValidation,
} from "./store/store";
import { BehaviorConfig } from "./modes/base.behavior";
import { cartesianDistance } from "./geometry/measure/pixel-distance";
import { pixelDistanceToLine } from "./geometry/measure/pixel-distance-to-line";
import { Position } from "geojson";
import { pointInPolygon } from "./geometry/boolean/point-in-polygon";
import { createBBoxFromPoint } from "./geometry/shape/create-bbox";
import { ValidateMinAreaSquareMeters } from "./validations/min-size.validation";
import { ValidateMaxAreaSquareMeters } from "./validations/max-size.validation";
import { ValidateNotSelfIntersecting } from "./validations/not-self-intersecting.validation";
import { TerraDrawAngledRectangleMode } from "./modes/angled-rectangle/angled-rectangle.mode";
import { TerraDrawSectorMode } from "./modes/sector/sector.mode";
import { TerraDrawSensorMode } from "./modes/sensor/sensor.mode";
import * as TerraDrawExtend from "./extend";
import { hasModeProperty } from "./store/store-feature-validation";
import { ValidationReasons } from "./validation-reasons";
import { TerraDrawFreehandLineStringMode } from "./modes/freehand-linestring/freehand-linestring.mode";

// Helper type to determine the instance type of a class
type InstanceType<T extends new (...args: any[]) => any> = T extends new (
	...args: any[]
) => infer R
	? R
	: never;

type FinishListener = (id: FeatureId, context: OnFinishContext) => void;
type ChangeListener = (
	ids: FeatureId[],
	type: string,
	context?: OnChangeContext,
) => void;
type SelectListener = (id: FeatureId) => void;
type DeselectListener = () => void;

interface TerraDrawEventListeners {
	ready: () => void;
	finish: FinishListener;
	change: ChangeListener;
	select: SelectListener;
	deselect: DeselectListener;
}

type GetFeatureOptions = {
	pointerDistance?: number;
	includePolygonsWithinPointerDistance?: boolean;
	ignoreSelectFeatures?: boolean;
	ignoreCoordinatePoints?: boolean;
	ignoreCurrentlyDrawing?: boolean;
	ignoreClosingPoints?: boolean;
};

type TerraDrawEvents = keyof TerraDrawEventListeners;

class TerraDraw {
	private _modes: {
		[mode: string]: TerraDrawBaseDrawMode<any> | TerraDrawBaseSelectMode<any>;
	};
	private _mode: TerraDrawBaseDrawMode<any> | TerraDrawBaseSelectMode<any>;
	private _adapter: TerraDrawAdapter;
	private _enabled = false;
	private _store: TerraDrawGeoJSONStore;
	private _eventListeners: {
		ready: (() => void)[];
		change: ChangeListener[];
		finish: FinishListener[];
		select: SelectListener[];
		deselect: DeselectListener[];
	};
	// This is the select mode that is assigned in the instance.
	// There can only be 1 select mode active per instance
	private _instanceSelectMode: undefined | string;

	constructor(options: {
		adapter: TerraDrawAdapter;
		modes: TerraDrawBaseDrawMode<any>[];
		idStrategy?: IdStrategy<FeatureId>;
		tracked?: boolean;
	}) {
		this._adapter = options.adapter;

		this._mode = new TerraDrawStaticMode();

		// Keep track of if there are duplicate modes
		const duplicateModeTracker = new Set();

		// Construct a map of the mode name to the mode
		const modesMap = options.modes.reduce<{
			[mode: string]: TerraDrawBaseDrawMode<any>;
		}>((modeMap, currentMode) => {
			if (duplicateModeTracker.has(currentMode.mode)) {
				throw new Error(`There is already a ${currentMode.mode} mode provided`);
			}
			duplicateModeTracker.add(currentMode.mode);
			modeMap[currentMode.mode] = currentMode;
			return modeMap;
		}, {});

		// Construct an array of the mode keys (names)
		const modeKeys = Object.keys(modesMap);

		// Ensure at least one draw mode is provided
		if (modeKeys.length === 0) {
			throw new Error("No modes provided");
		}

		// Ensure only one select mode can be present
		modeKeys.forEach((mode) => {
			if (modesMap[mode].type !== ModeTypes.Select) {
				return;
			}
			if (this._instanceSelectMode) {
				throw new Error("only one type of select mode can be provided");
			} else {
				this._instanceSelectMode = mode;
			}
		});

		this._modes = { ...modesMap, static: this._mode };
		this._eventListeners = {
			change: [],
			select: [],
			deselect: [],
			finish: [],
			ready: [],
		};
		this._store = new GeoJSONStore<OnChangeContext | undefined, FeatureId>({
			tracked: options.tracked ? true : false,
			idStrategy: options.idStrategy ? options.idStrategy : undefined,
		});

		const getChanged = (
			ids: FeatureId[],
		): {
			changed: GeoJSONStoreFeatures[];
			unchanged: GeoJSONStoreFeatures[];
		} => {
			const changed: GeoJSONStoreFeatures[] = [];

			const unchanged = this._store.copyAll().filter((f) => {
				if (ids.includes(f.id as string)) {
					changed.push(f);
					return false;
				}

				return true;
			});

			return { changed, unchanged };
		};

		const onFinish = (finishedId: FeatureId, context: OnFinishContext) => {
			if (!this._enabled) {
				return;
			}

			this._eventListeners.finish.forEach((listener) => {
				listener(finishedId, context);
			});
		};

		const onChange: StoreChangeHandler<OnChangeContext | undefined> = (
			ids,
			event,
			context,
		) => {
			if (!this._enabled) {
				return;
			}

			this._eventListeners.change.forEach((listener) => {
				listener(ids, event, context);
			});

			const { changed, unchanged } = getChanged(ids);

			if (event === "create") {
				this._adapter.render(
					{
						created: changed,
						deletedIds: [],
						unchanged,
						updated: [],
					},
					this.getModeStyles(),
				);
			} else if (event === "update") {
				this._adapter.render(
					{
						created: [],
						deletedIds: [],
						unchanged,
						updated: changed,
					},
					this.getModeStyles(),
				);
			} else if (event === "delete") {
				this._adapter.render(
					{ created: [], deletedIds: ids, unchanged, updated: [] },
					this.getModeStyles(),
				);
			} else if (event === "styling") {
				this._adapter.render(
					{ created: [], deletedIds: [], unchanged, updated: [] },
					this.getModeStyles(),
				);
			}
		};

		const onSelect = (selectedId: string) => {
			if (!this._enabled) {
				return;
			}

			this._eventListeners.select.forEach((listener) => {
				listener(selectedId);
			});

			const { changed, unchanged } = getChanged([selectedId]);

			this._adapter.render(
				{ created: [], deletedIds: [], unchanged, updated: changed },
				this.getModeStyles(),
			);
		};

		const onDeselect = (deselectedId: string) => {
			if (!this._enabled) {
				return;
			}

			this._eventListeners.deselect.forEach((listener) => {
				listener();
			});

			const { changed, unchanged } = getChanged([deselectedId]);

			// onDeselect can be called after a delete call which means that
			// you are deselecting a feature that has been deleted. We
			// double check here to ensure that the feature still exists.
			if (changed) {
				this._adapter.render(
					{
						created: [],
						deletedIds: [],
						unchanged,
						updated: changed,
					},
					this.getModeStyles(),
				);
			}
		};

		// Register stores and callbacks
		Object.keys(this._modes).forEach((modeId) => {
			this._modes[modeId].register({
				mode: modeId,
				store: this._store,
				setCursor: this._adapter.setCursor.bind(this._adapter),
				project: this._adapter.project.bind(this._adapter),
				unproject: this._adapter.unproject.bind(this._adapter),
				setDoubleClickToZoom: this._adapter.setDoubleClickToZoom.bind(
					this._adapter,
				),
				onChange: onChange,
				onSelect: onSelect,
				onDeselect: onDeselect,
				onFinish: onFinish,
				coordinatePrecision: this._adapter.getCoordinatePrecision(),
			});
		});
	}

	private checkEnabled() {
		if (!this._enabled) {
			throw new Error("Terra Draw is not enabled");
		}
	}

	private getModeStyles() {
		const modeStyles: {
			[key: string]: (feature: GeoJSONStoreFeatures) => TerraDrawAdapterStyling;
		} = {};

		Object.keys(this._modes).forEach((mode) => {
			modeStyles[mode] = (feature: GeoJSONStoreFeatures) => {
				// If the feature is selected, we want to use the select mode styling
				if (
					this._instanceSelectMode &&
					feature.properties[SELECT_PROPERTIES.SELECTED]
				) {
					return this._modes[this._instanceSelectMode].styleFeature.bind(
						this._modes[this._instanceSelectMode],
					)(feature);
				}

				// Otherwise use regular styling
				return this._modes[mode].styleFeature.bind(this._modes[mode])(feature);
			};
		});
		return modeStyles;
	}

	private featuresAtLocation(
		{
			lng,
			lat,
		}: {
			lng: number;
			lat: number;
		},
		options?: GetFeatureOptions,
	) {
		const pointerDistance =
			options && options.pointerDistance !== undefined
				? options.pointerDistance
				: 30; // default is 30px

		const ignoreSelectFeatures =
			options && options.ignoreSelectFeatures !== undefined
				? options.ignoreSelectFeatures
				: true;

		const ignoreCoordinatePoints =
			options && options.ignoreCoordinatePoints !== undefined
				? options.ignoreCoordinatePoints
				: false;

		const ignoreCurrentlyDrawing =
			options && options.ignoreCurrentlyDrawing !== undefined
				? options.ignoreCurrentlyDrawing
				: false;

		const ignoreClosingPoints =
			options && options.ignoreClosingPoints !== undefined
				? options.ignoreClosingPoints
				: false;

		const unproject = this._adapter.unproject.bind(this._adapter);
		const project = this._adapter.project.bind(this._adapter);

		const inputPoint = project(lng, lat);

		const bbox = createBBoxFromPoint({
			unproject,
			point: inputPoint,
			pointerDistance,
		});

		const features = this._store.search(bbox as BBoxPolygon);

		return features.filter((feature) => {
			if (
				ignoreSelectFeatures &&
				(feature.properties[SELECT_PROPERTIES.MID_POINT] ||
					feature.properties[SELECT_PROPERTIES.SELECTION_POINT])
			) {
				return false;
			}

			if (
				ignoreCoordinatePoints &&
				feature.properties[COMMON_PROPERTIES.COORDINATE_POINT]
			) {
				return false;
			}

			if (
				ignoreClosingPoints &&
				feature.properties[COMMON_PROPERTIES.CLOSING_POINT]
			) {
				return false;
			}

			if (
				ignoreCurrentlyDrawing &&
				feature.properties[COMMON_PROPERTIES.CURRENTLY_DRAWING]
			) {
				return false;
			}

			if (feature.geometry.type === "Point") {
				const pointCoordinates = feature.geometry.coordinates;
				const pointXY = project(pointCoordinates[0], pointCoordinates[1]);
				const distance = cartesianDistance(inputPoint, pointXY);
				return distance < pointerDistance;
			} else if (feature.geometry.type === "LineString") {
				const coordinates: Position[] = feature.geometry.coordinates;

				for (let i = 0; i < coordinates.length - 1; i++) {
					const coord = coordinates[i];
					const nextCoord = coordinates[i + 1];
					const distanceToLine = pixelDistanceToLine(
						inputPoint,
						project(coord[0], coord[1]),
						project(nextCoord[0], nextCoord[1]),
					);

					if (distanceToLine < pointerDistance) {
						return true;
					}
				}
				return false;
			} else {
				const lngLatInsidePolygon = pointInPolygon(
					[lng, lat],
					feature.geometry.coordinates,
				);

				if (lngLatInsidePolygon) {
					return true;
				}

				if (options?.includePolygonsWithinPointerDistance) {
					const rings: Position[][] = feature.geometry.coordinates;

					for (const ring of rings) {
						for (let i = 0; i < ring.length - 1; i++) {
							const coord = ring[i];
							const nextCoord = ring[i + 1];

							const projectedStart = project(coord[0], coord[1]);
							const projectedEnd = project(nextCoord[0], nextCoord[1]);

							const distanceToEdge = pixelDistanceToLine(
								inputPoint,
								projectedStart,
								projectedEnd,
							);

							if (distanceToEdge < pointerDistance) {
								return true;
							}
						}
					}
				}

				return false;
			}
		});
	}

	private getSelectModeOrThrow() {
		const selectMode = this.getSelectMode({ switchToSelectMode: true });

		if (!selectMode) {
			throw new Error("No select mode defined in instance");
		}

		return selectMode;
	}

	private getSelectMode({
		switchToSelectMode,
	}: {
		switchToSelectMode: boolean;
	}) {
		this.checkEnabled();

		if (!this._instanceSelectMode) {
			return null;
		}

		const currentMode = this.getMode();

		// If we're not already in the select mode, we switch to it
		if (switchToSelectMode && currentMode !== this._instanceSelectMode) {
			this.setMode(this._instanceSelectMode);
		}

		const selectMode = this._modes[
			this._instanceSelectMode
		] as TerraDrawBaseSelectMode<any>;

		return selectMode;
	}

	private isGuidanceFeature(feature: GeoJSONStoreFeatures): boolean {
		return Boolean(
			feature.properties[SELECT_PROPERTIES.MID_POINT] ||
				feature.properties[SELECT_PROPERTIES.SELECTION_POINT] ||
				feature.properties[COMMON_PROPERTIES.COORDINATE_POINT] ||
				feature.properties[COMMON_PROPERTIES.SNAPPING_POINT],
		);
	}

	/**
	 * @deprecated This method is scheduled for removal in the next major version. Instead use the 'updateModeOptions' method passing the
	 * styles property in the options object, and this will dynamically update the styles for the mode.
	 *
	 * Allows the setting of a style for a given mode
	 *
	 * @param mode - The mode you wish to set a style for
	 * @param styles - The styles you wish to set for the mode - this is
	 * the same as the initialisation style schema
	 */
	setModeStyles<Styling extends Record<string, number | HexColor>>(
		mode: string,
		styles: Styling,
	) {
		this.checkEnabled();
		if (!this._modes[mode]) {
			throw new Error("No mode with this name present");
		}

		// TODO: Not sure why this fails TypeScript with TerraDrawBaseSelectMode?
		(this._modes[mode] as TerraDrawBaseDrawMode<any>).styles = styles;
	}

	/**
	 * Allow updating of the current options passed to the mode dynamically
	 * after the mode has been started. You can also use this method to update styles
	 * as these are passed from the options object.
	 * @param mode - the mode name you wish to update (the mode name is the public 'mode' property of the mode class)
	 * @param options - the options object - this allows _partial_ updating of the modes options (i.e. you do not need to pass the whole options object)
	 */
	updateModeOptions<Mode extends { new (...args: any[]): any }>(
		mode: InstanceType<Mode>["mode"],
		options: ConstructorParameters<Mode>[0],
	) {
		this.checkEnabled();
		if (!this._modes[mode]) {
			throw new Error("No mode with this name present");
		}

		this._modes[mode].updateOptions(
			options as TerraDrawExtend.BaseModeOptions<any>,
		);
	}

	/**
	 * Allows the user to get a snapshot (copy) of all given features
	 *
	 * @returns An array of all given Feature Geometries in the instances store
	 */
	getSnapshot() {
		// This is a read only method so we do not need to check if enabled
		return this._store.copyAll();
	}

	/**
	 * Allows the user to get a snapshot (copy) of a given feature by id
	 *
	 * @returns A copy of the feature geometry in the instances store
	 */
	getSnapshotFeature(id: FeatureId) {
		if (!this._store.has(id)) {
			return undefined;
		}

		return this._store.copy(id);
	}

	/**
	 * Removes all data from the current store and ensures any rendered data is cleared
	 * from the map.
	 */
	clear() {
		this.checkEnabled();
		this._adapter.clear();
	}

	/**
	 * A property used to determine whether the instance is active or not. You
	 * can use the start method to set this to true, and stop method to set this to false.
	 * This is a read only property.
	 *
	 * @return true or false depending on if the instance is stopped or started
	 * @readonly
	 */
	get enabled(): boolean {
		return this._enabled;
	}

	/**
	 * enabled is a read only property and will throw and error if you try and set it.
	 */
	set enabled(_) {
		throw new Error("Enabled is read only");
	}

	/**
	 * A method for getting the current mode name
	 * @return the current mode name
	 */
	getMode(): string {
		// This is a read only method so we do not need to check if enabled
		return this._mode.mode;
	}

	/**
	 * Get the state of the mode i.e. if we are currently unregistered, registered, drawing etc. This can
	 * be used to make decisions based on what the current mode is doing.
	 * @returns the current mode state as a string
	 */
	getModeState() {
		return this._mode.state;
	}

	/**
	 * A method for setting the current mode by name. Under the hood this will stop
	 * the previous mode and start the new one.
	 * @param mode - The mode name you wish to start
	 */
	setMode(mode: string) {
		this.checkEnabled();

		if (this._modes[mode]) {
			// Before we swap modes we want to
			// clean up any state that has been left behind,
			// for example current drawing geometries
			// and mode state
			this._mode.stop();

			// Swap the mode to the new mode
			this._mode = this._modes[mode];

			// Start the new mode
			this._mode.start();
		} else {
			// If the mode doesn't exist, we throw an error
			throw new Error("No mode with this name present");
		}
	}

	/**
	 * A method for removing features to the store
	 * @param ids
	 * @returns
	 */
	removeFeatures(ids: FeatureId[]) {
		this.checkEnabled();

		const coordinatePointsToDelete: FeatureId[] = [];

		ids.forEach((id) => {
			// Deselect any passed features - this removes all selection points and midpoints
			if (!this._store.has(id)) {
				throw new Error(`No feature with id ${id}, can not delete`);
			}

			const feature = this._store.copy(id);
			if (feature.properties[SELECT_PROPERTIES.SELECTED]) {
				this.deselectFeature(id);
			}

			// If the feature has coordinate points, we want to remove them as well
			if (feature.properties[COMMON_PROPERTIES.COORDINATE_POINT_IDS]) {
				coordinatePointsToDelete.push(
					...(feature.properties[
						COMMON_PROPERTIES.COORDINATE_POINT_IDS
					] as FeatureId[]),
				);
			}
		});

		this._store.delete([...ids, ...coordinatePointsToDelete], {
			origin: "api",
		});
	}

	/**
	 * Provides the ability to programmatically select a feature using the instances provided select mode.
	 * If not select mode is provided in the instance, an error will be thrown. If the instance is not currently
	 * in the select mode, it will switch to it.
	 * @param id - the id of the feature to select
	 */
	selectFeature(id: FeatureId) {
		const selectMode = this.getSelectModeOrThrow();
		selectMode.selectFeature(id);
	}

	/**
	 * Provides the ability to programmatically deselect a feature using the instances provided select mode.
	 * If not select mode is provided in the instance, an error will be thrown. If the instance is not currently
	 * in the select mode, it will switch to it.
	 * @param id  - the id of the feature to deselect
	 */
	deselectFeature(id: FeatureId) {
		const selectMode = this.getSelectModeOrThrow();
		selectMode.deselectFeature(id);
	}

	/**
	 * Returns the next feature id from the store - defaults to UUID4 unless you have
	 * set a custom idStrategy. This method can be useful if you are needing creating features
	 * outside of the Terra Draw instance but want to add them in to the store.
	 * @returns a id, either number of string based on whatever the configured idStrategy is
	 *
	 */
	getFeatureId(): FeatureId {
		return this._store.getId();
	}

	/**
	 * Returns true or false depending on if the Terra Draw instance has a feature with a given id
	 * @returns a boolean determining if the instance has a feature with the given id
	 */
	hasFeature(id: FeatureId): boolean {
		return this._store.has(id);
	}

	/**
	 * Updates a features geometry. This an be used to programmatically change the coordinates of a feature. This
	 * can be useful for if you want to modify a geometry via a button or some similar user interaction.
	 * @param id - the id of the feature to update the geometry for
	 * @param geometry - the new geometry that will replace the existing geometry
	 */
	updateFeatureGeometry(id: FeatureId, geometry: GeoJSONStoreGeometries) {
		if (!this._store.has(id)) {
			throw new Error(`No feature with id ${id} present in store`);
		}

		const feature = this._store.copy(id);

		// We don't want users to be able to update guidance features directly
		if (this.isGuidanceFeature(feature)) {
			throw new Error(
				`Guidance features are not allowed to be updated directly.`,
			);
		}

		// Ensure that the geometry is valid
		if (!feature || !geometry || !geometry.type || !geometry.coordinates) {
			throw new Error("Invalid geometry provided");
		}
		if (geometry.type !== feature.geometry.type) {
			throw new Error(
				`Geometry type mismatch: expected ${feature.geometry.type}, got ${geometry.type}`,
			);
		}

		const mode = feature.properties.mode;
		const modeToUpdate = this._modes[mode as string];

		if (!modeToUpdate) {
			throw new Error(`No mode with name ${mode} present in instance`);
		}

		const updatedFeature = { ...feature, geometry };

		const validationResult = modeToUpdate.validateFeature(updatedFeature);

		if (!validationResult.valid) {
			throw new Error(
				`Feature validation failed: ${validationResult.reason || "Unknown reason"}`,
			);
		}

		this._store.updateGeometry(
			[{ id: feature.id as FeatureId, geometry }],
			{ origin: "api" }, // origin is used to indicate that this update has come from an API call
		);

		// If the mode has an afterFeatureUpdated method, we call it
		if (modeToUpdate.afterFeatureUpdated) {
			modeToUpdate.afterFeatureUpdated(updatedFeature);

			const featureIsSelected =
				updatedFeature.properties[SELECT_PROPERTIES.SELECTED];
			const selectModePresent = this.getSelectMode({
				switchToSelectMode: false,
			});

			if (selectModePresent && featureIsSelected) {
				selectModePresent.afterFeatureUpdated(updatedFeature);
			}
		}
	}

	/**
	 * A method for adding features to the store. This method will validate the features
	 * returning an array of validation results. Features must match one of the modes enabled
	 * in the instance.
	 * @param features - an array of GeoJSON features
	 * @returns an array of validation results
	 */
	addFeatures(features: GeoJSONStoreFeatures[]): StoreValidation[] {
		this.checkEnabled();

		if (features.length === 0) {
			return [];
		}

		return this._store.load(
			features,
			(feature) => {
				// If the feature has a mode property, we use that to validate the feature
				if (hasModeProperty(feature)) {
					const featureMode = feature.properties.mode;
					const modeToAddTo = this._modes[featureMode];

					// if the mode does not exist, we return false
					if (!modeToAddTo) {
						return {
							id: (feature as { id?: FeatureId }).id,
							valid: false,
							reason: `${featureMode} mode is not in the list of instantiated modes`,
						};
					}

					// use the inbuilt validation of the mode
					const validation = modeToAddTo.validateFeature.bind(modeToAddTo);
					const validationResult = validation(feature);
					const valid = validationResult.valid;
					const reason = validationResult.reason
						? validationResult.reason
						: !validationResult.valid
							? "Feature is invalid"
							: undefined;
					return {
						id: (feature as { id?: FeatureId }).id,
						valid,
						reason,
					};
				}

				// If the feature does not have a mode property, we return false
				return {
					id: (feature as { id?: FeatureId }).id,
					valid: false,
					reason: "Mode property does not exist",
				};
			},
			(feature) => {
				if (hasModeProperty(feature)) {
					const featureMode = feature.properties.mode;
					const modeToAddTo = this._modes[featureMode];
					if (modeToAddTo && modeToAddTo.afterFeatureAdded) {
						modeToAddTo.afterFeatureAdded(feature);
					}
				}
			},
			{ origin: "api" },
		);
	}

	/**
	 * A method starting Terra Draw. It put the instance into a started state, and
	 * in registers the passed adapter giving it all the callbacks required to operate.
	 */
	start() {
		// If the instance is already enabled, we do nothing
		if (this._enabled) {
			return;
		}

		this._enabled = true;
		this._adapter.register({
			onReady: () => {
				this._eventListeners.ready.forEach((listener) => {
					listener();
				});
			},
			getState: () => {
				return this._mode.state;
			},
			onClick: (event) => {
				this._mode.onClick(event);
			},
			onMouseMove: (event) => {
				this._mode.onMouseMove(event);
			},
			onKeyDown: (event) => {
				this._mode.onKeyDown(event);
			},
			onKeyUp: (event) => {
				this._mode.onKeyUp(event);
			},
			onDragStart: (event, setMapDraggability) => {
				this._mode.onDragStart(event, setMapDraggability);
			},
			onDrag: (event, setMapDraggability) => {
				this._mode.onDrag(event, setMapDraggability);
			},
			onDragEnd: (event, setMapDraggability) => {
				this._mode.onDragEnd(event, setMapDraggability);
			},
			onClear: () => {
				// Ensure that the mode resets its state
				// as it may be storing feature ids internally in it's instance
				this._mode.cleanUp();

				// Remove all features from the store
				this._store.clear();
			},
		});
	}

	/**
	 * Gets the features at a given longitude and latitude.
	 * Will return point and linestrings that are a given pixel distance
	 * away from the lng/lat and any polygons which contain it.
	 */
	getFeaturesAtLngLat(
		lngLat: { lng: number; lat: number },
		options?: GetFeatureOptions,
	) {
		const { lng, lat } = lngLat;

		return this.featuresAtLocation(
			{
				lng,
				lat,
			},
			options,
		);
	}

	/**
	 * Takes a given pointer event and will return point and linestrings that are
	 * a given pixel distance away from the longitude/latitude, and any polygons which contain it.
	 */
	getFeaturesAtPointerEvent(
		event: PointerEvent | MouseEvent,
		options?: GetFeatureOptions,
	) {
		const getLngLatFromEvent = this._adapter.getLngLatFromEvent.bind(
			this._adapter,
		);

		const lngLat = getLngLatFromEvent(event);

		// If the pointer event is outside the container or the underlying library is
		// not ready we can get null as a returned value
		if (lngLat === null) {
			return [];
		}

		return this.featuresAtLocation(lngLat, options);
	}

	/**
	 * A method for stopping Terra Draw. Will clear the store, deregister the adapter and
	 * remove any rendered layers in the process.
	 */
	stop() {
		// If the instance is already stopped, we do nothing
		if (!this._enabled) {
			return;
		}

		this._enabled = false;
		this._adapter.unregister();
	}

	/**
	 * Registers a Terra Draw event
	 *
	 * @param event - The name of the event you wish to listen for
	 * @param callback - The callback with you wish to be called when this event occurs
	 *
	 */
	on<T extends TerraDrawEvents>(
		event: T,
		callback: TerraDrawEventListeners[T],
	) {
		const listeners = this._eventListeners[
			event
		] as TerraDrawEventListeners[T][];
		if (!listeners.includes(callback)) {
			listeners.push(callback);
		}
	}

	/**
	 * Unregisters a Terra Draw event
	 *
	 * @param event - The name of the event you wish to unregister
	 * @param callback - The callback you originally provided to the 'on' method
	 *
	 */
	off<T extends TerraDrawEvents>(
		event: TerraDrawEvents,
		callback: TerraDrawEventListeners[T],
	) {
		const listeners = this._eventListeners[
			event
		] as TerraDrawEventListeners[T][];
		if (listeners.includes(callback)) {
			listeners.splice(listeners.indexOf(callback), 1);
		}
	}
}

export {
	TerraDraw,
	type IdStrategy,
	type TerraDrawEvents,
	type TerraDrawEventListeners,

	// Modes
	TerraDrawSelectMode,
	TerraDrawPointMode,
	TerraDrawLineStringMode,
	TerraDrawPolygonMode,
	TerraDrawCircleMode,
	TerraDrawFreehandMode,
	TerraDrawFreehandLineStringMode,
	TerraDrawRenderMode,
	TerraDrawRectangleMode,
	TerraDrawAngledRectangleMode,
	TerraDrawSectorMode,
	TerraDrawSensorMode,

	// Types that are required for 3rd party developers to extend
	TerraDrawExtend,

	// TerraDrawBaseMode
	type BehaviorConfig,
	type GeoJSONStoreFeatures,
	type GeoJSONStoreGeometries,
	type HexColor,
	type TerraDrawMouseEvent,
	type TerraDrawAdapterStyling,
	type TerraDrawKeyboardEvent,

	// TerraDrawBaseAdapter
	type TerraDrawChanges,
	type TerraDrawStylingFunction,
	type Project,
	type Unproject,
	type SetCursor,
	type GetLngLatFromEvent,

	// Validations
	ValidateMinAreaSquareMeters,
	ValidateMaxAreaSquareMeters,
	ValidateNotSelfIntersecting,
	ValidationReasons,
};
