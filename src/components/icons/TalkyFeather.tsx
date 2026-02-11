export function TalkyFeather({
  size = 24,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="currentColor"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M27.5 4.5c-1.5-1.5-4-1.5-5.5 0L6 20.5c-.8.8-1.4 1.8-1.7 2.9L3 28c-.1.4 0 .8.3 1.1.2.2.5.4.8.4h.3l4.6-1.3c1.1-.3 2.1-.9 2.9-1.7L28 10.5c1.5-1.5 1.5-4 0-5.5l-.5-.5zM9.4 24.9c-.5.5-1.1.9-1.8 1.1L4.5 27l1-3.1c.2-.7.5-1.3 1-1.8L18 10.5l3.5 3.5L9.4 24.9zm17.2-15.8l-5.1 5.1L18 10.7l5.1-5.1c.6-.6 1.5-.6 2.1 0l1.4 1.4c.6.6.6 1.5 0 2.1z" />
      <path
        d="M10 22l-2 6M14 18l-4 4M18 14l-4 4"
        stroke="currentColor"
        strokeWidth="0.5"
        fill="none"
        opacity="0.3"
      />
    </svg>
  );
}
