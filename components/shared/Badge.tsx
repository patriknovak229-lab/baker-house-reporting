'use client';
import type { ReactNode } from "react";

interface BadgeProps {
  children: ReactNode;
  variant:
    | "blue"
    | "red"
    | "green"
    | "amber"
    | "gray"
    | "gold"
    | "coral"
    | "indigo";
  size?: "sm" | "xs";
}

const variantClasses: Record<BadgeProps["variant"], string> = {
  blue: "bg-blue-100 text-blue-800",
  red: "bg-red-100 text-red-700",
  green: "bg-green-100 text-green-800",
  amber: "bg-amber-100 text-amber-800",
  gray: "bg-gray-100 text-gray-600",
  gold: "bg-yellow-100 text-yellow-800",
  coral: "bg-rose-100 text-rose-700",
  indigo: "bg-indigo-100 text-indigo-800",
};

export default function Badge({
  children,
  variant,
  size = "sm",
}: BadgeProps) {
  const sizeClasses = size === "xs" ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-0.5 text-xs";
  return (
    <span
      className={`inline-flex items-center rounded-full font-medium whitespace-nowrap ${sizeClasses} ${variantClasses[variant]}`}
    >
      {children}
    </span>
  );
}
