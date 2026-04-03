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
    | "indigo"
    | "teal"
  | "purple"
  | "amber-filled"
  | "green-filled"
  | "orange"
  | "orange-light";
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
  teal: "bg-teal-100 text-teal-800",
  purple: "bg-purple-600 text-white ring-1 ring-purple-400",
  "amber-filled": "bg-amber-500 text-white",
  "green-filled": "bg-green-600 text-white",
  "orange": "bg-orange-500 text-white",
  "orange-light": "bg-orange-100 text-orange-800",
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
