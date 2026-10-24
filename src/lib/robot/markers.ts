// BioBuzz: draws robot actions placed along paths as diamonds on the field.
import Two from "two.js";
import type { BasePoint, Path } from "../../types";
import { curveGeometryAtCompletion, flattenToAtomicSegments } from "../../utils/pathTraversal";

type Scale = (value: number) => number;

export function buildRobotMarkers(startPoint: BasePoint, lines: Path[], x: Scale, y: Scale): any[] {
  const shapes: any[] = [];
  for (const segment of flattenToAtomicSegments(startPoint, lines)) {
    for (const event of segment.line.robotEvents ?? []) {
      const { point } = curveGeometryAtCompletion(segment.points, event.at);
      const diamond = new Two.Polygon(x(point.x), y(point.y), 9, 4);
      diamond.fill = "#f5b301";
      diamond.stroke = "#1a1300";
      diamond.linewidth = 2;
      diamond.id = `robot-event-${event.id}`;
      shapes.push(diamond);
    }
  }
  return shapes;
}
