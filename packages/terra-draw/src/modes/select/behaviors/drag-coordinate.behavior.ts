import {
	Snapping,
	TerraDrawMouseEvent,
	UpdateTypes,
	Validation,
} from "../../../common";
import { BehaviorConfig, TerraDrawModeBehavior } from "../../base.behavior";

import { LineString, Polygon, Position, Point, Feature } from "geojson";
import { PixelDistanceBehavior } from "../../pixel-distance.behavior";
import { MidPointBehavior } from "./midpoint.behavior";
import { SelectionPointBehavior } from "./selection-point.behavior";
import { selfIntersects } from "../../../geometry/boolean/self-intersects";
import { FeatureId, GeoJSONStoreFeatures } from "../../../store/store";
import { CoordinatePointBehavior } from "./coordinate-point.behavior";
import { CoordinateSnappingBehavior } from "../../coordinate-snapping.behavior";
import { LineSnappingBehavior } from "../../line-snapping.behavior";

export class DragCoordinateBehavior extends TerraDrawModeBehavior {
	constructor(
		readonly config: BehaviorConfig,
		private readonly pixelDistance: PixelDistanceBehavior,
		private readonly selectionPoints: SelectionPointBehavior,
		private readonly midPoints: MidPointBehavior,
		private readonly coordinatePoints: CoordinatePointBehavior,
		private readonly coordinateSnapping: CoordinateSnappingBehavior,
		private readonly lineSnapping: LineSnappingBehavior,
	) {
		super(config);
	}

	private draggedCoordinate: { id: null | FeatureId; index: number } = {
		id: null,
		index: -1,
	};

	private getClosestCoordinate(
		event: TerraDrawMouseEvent,
		geometry: Polygon | LineString | Point,
	) {
		const closestCoordinate = {
			dist: Infinity,
			index: -1,
			isFirstOrLastPolygonCoord: false,
		};

		let geomCoordinates: Position[] | undefined;

		if (geometry.type === "LineString") {
			geomCoordinates = geometry.coordinates;
		} else if (geometry.type === "Polygon") {
			geomCoordinates = geometry.coordinates[0];
		} else {
			// We don't want to handle dragging
			// points here
			return closestCoordinate;
		}

		// Look through the selected features coordinates
		// and try to find a coordinate that is draggable
		for (let i = 0; i < geomCoordinates.length; i++) {
			const coord = geomCoordinates[i];
			const distance = this.pixelDistance.measure(event, coord);

			if (
				distance < this.pointerDistance &&
				distance < closestCoordinate.dist
			) {
				// We don't create a point for the final
				// polygon coord, so we must set it to the first
				// coordinate instead
				const isFirstOrLastPolygonCoord =
					geometry.type === "Polygon" &&
					(i === geomCoordinates.length - 1 || i === 0);

				closestCoordinate.dist = distance;
				closestCoordinate.index = isFirstOrLastPolygonCoord ? 0 : i;
				closestCoordinate.isFirstOrLastPolygonCoord = isFirstOrLastPolygonCoord;
			}
		}

		return closestCoordinate;
	}

	public getDraggableIndex(
		event: TerraDrawMouseEvent,
		selectedId: FeatureId,
	): number {
		const geometry = this.store.getGeometryCopy(selectedId);
		const closestCoordinate = this.getClosestCoordinate(event, geometry);

		// No coordinate was within the pointer distance
		if (closestCoordinate.index === -1) {
			return -1;
		}
		return closestCoordinate.index;
	}

	private snapCoordinate(
		event: TerraDrawMouseEvent,
		snapping: Snapping,
		draggedFeature: GeoJSONStoreFeatures,
	): Position {
		let snappedCoordinate: Position = [event.lng, event.lat];

		// This is a uniform filter we can use across all snapping behaviors
		const filter = (feature: Feature) => {
			return Boolean(
				feature.properties &&
					feature.properties.mode === draggedFeature.properties.mode &&
					feature.id !== this.draggedCoordinate.id,
			);
		};

		if (snapping?.toLine) {
			let snapped: Position | undefined;

			snapped = this.lineSnapping.getSnappable(event, filter).coordinate;

			if (snapped) {
				snappedCoordinate = snapped;
			}
		}

		if (snapping.toCoordinate) {
			let snapped: Position | undefined = undefined;

			snapped = this.coordinateSnapping.getSnappable(event, filter).coordinate;

			if (snapped) {
				snappedCoordinate = snapped;
			}
		}

		if (snapping?.toCustom) {
			let snapped: Position | undefined = undefined;

			snapped = snapping.toCustom(event, {
				currentCoordinate: this.draggedCoordinate.index,
				currentId: draggedFeature.id,
				getCurrentGeometrySnapshot: draggedFeature.id
					? () =>
							this.store.getGeometryCopy<Polygon>(
								draggedFeature.id as FeatureId,
							)
					: () => null,
				project: this.project,
				unproject: this.unproject,
			});

			if (snapped) {
				snappedCoordinate = snapped;
			}
		}

		return snappedCoordinate;
	}

	drag(
		event: TerraDrawMouseEvent,
		allowSelfIntersection: boolean,
		validateFeature: Validation,
		snapping: Snapping,
	): boolean {
		const draggedFeatureId = this.draggedCoordinate.id;

		if (draggedFeatureId === null) {
			return false;
		}

		const index = this.draggedCoordinate.index;
		const geometry = this.store.getGeometryCopy(draggedFeatureId);
		const properties = this.store.getPropertiesCopy(draggedFeatureId);

		const geomCoordinates = (
			geometry.type === "LineString"
				? geometry.coordinates
				: geometry.coordinates[0]
		) as Position[];

		const isFirstOrLastPolygonCoord =
			geometry.type === "Polygon" &&
			(index === geomCoordinates.length - 1 || index === 0);

		const draggedFeature: GeoJSONStoreFeatures = {
			type: "Feature",
			id: draggedFeatureId,
			geometry,
			properties,
		};

		const updatedCoordinate = this.snapCoordinate(
			event,
			snapping,
			draggedFeature,
		);

		// Ensure that coordinates do not exceed
		// lng lat limits. Long term we may want to figure out
		// proper handling of anti meridian crossings
		if (
			event.lng > 180 ||
			event.lng < -180 ||
			event.lat > 90 ||
			event.lat < -90
		) {
			return false;
		}

		// We want to update the actual Polygon/LineString itself -
		// for Polygons we want the first and last coordinates to match
		if (isFirstOrLastPolygonCoord) {
			const lastCoordIndex = geomCoordinates.length - 1;
			geomCoordinates[0] = updatedCoordinate;
			geomCoordinates[lastCoordIndex] = updatedCoordinate;
		} else {
			geomCoordinates[index] = updatedCoordinate;
		}

		const updatedSelectionPoint = this.selectionPoints.getOneUpdated(
			index,
			updatedCoordinate,
		);

		const updatedSelectionPoints = updatedSelectionPoint
			? [updatedSelectionPoint]
			: [];

		const updatedMidPoints = this.midPoints.getUpdated(geomCoordinates) || [];

		const updatedCoordinatePoints =
			this.coordinatePoints.getUpdated(draggedFeatureId, geomCoordinates) || [];

		if (
			geometry.type !== "Point" &&
			!allowSelfIntersection &&
			selfIntersects({
				type: "Feature",
				geometry: geometry,
				properties: {},
			} as Feature<Polygon>)
		) {
			return false;
		}

		if (validateFeature) {
			const validationResult = validateFeature(draggedFeature, {
				project: this.config.project,
				unproject: this.config.unproject,
				coordinatePrecision: this.config.coordinatePrecision,
				updateType: UpdateTypes.Provisional,
			});

			if (!validationResult.valid) {
				return false;
			}
		}

		// Apply all the updates
		this.store.updateGeometry([
			// Update feature
			{
				id: draggedFeatureId,
				geometry: geometry,
			},
			// Update selection and mid points
			...updatedSelectionPoints,
			...updatedMidPoints,
			...updatedCoordinatePoints,
		]);

		return true;
	}

	isDragging() {
		return this.draggedCoordinate.id !== null;
	}

	startDragging(id: FeatureId, index: number) {
		this.draggedCoordinate = {
			id,
			index,
		};
	}

	stopDragging() {
		this.draggedCoordinate = {
			id: null,
			index: -1,
		};
	}
}
