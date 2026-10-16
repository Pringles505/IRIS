import React from 'react';
import { Circle, Group, Line } from 'react-konva';
import { getPointAtProgress } from '../../links/linkGeometry';
import { getLinkFailureMarkGeometry, linkCanFail } from '../../animation/nodeFailureStyle';

export default function LinkFailureMark({ link, render }) {
  if (!link || !render || !linkCanFail(link)) return null;
  const midpoint = getPointAtProgress(render, 0.5, true)?.point ?? render.endPoint;
  const fail = getLinkFailureMarkGeometry(link);

  return (
    <Group
      id={`link-fail-${link.id}`}
      x={midpoint.x}
      y={midpoint.y}
      opacity={link.failing ? 1 : 0}
      listening={false}
    >
      {fail.halo && (
        <>
          <Circle radius={fail.halo.glowRadius} fill={fail.style.color} opacity={0.18} />
          <Circle radius={fail.halo.ringRadius} stroke={fail.style.color} strokeWidth={1} opacity={0.35} />
        </>
      )}
      {fail.ring != null && (
        <Circle radius={fail.ring} stroke={fail.style.color} strokeWidth={fail.strokeWidth} />
      )}
      {fail.lines.map((points, i) => (
        <Line key={i} points={points} stroke={fail.style.color} strokeWidth={fail.strokeWidth} lineCap="round" />
      ))}
    </Group>
  );
}
