export default function Icon() {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", "0 0 300 300");
	svg.setAttribute("fill", "none");
	svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
	const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
	g.setAttribute("clip-path", "url(#clip0_1_14)");
	const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
	rect.setAttribute("x", "19.569");
	rect.setAttribute("y", "19.569");
	rect.setAttribute("width", "260.66");
	rect.setAttribute("height", "260.66");
	rect.setAttribute("rx", "30.431");
	rect.setAttribute("stroke", "currentColor");
	rect.setAttribute("stroke-width", "39.138");
	const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
	path.setAttribute(
		"d",
		"M150.149 262.239V110.966h56.727c11.621 0 21.371 2.167 29.25 6.5 7.928 4.334 13.911 10.292 17.949 17.875 4.087 7.534 6.131 16.103 6.131 25.705 0 9.701-2.044 18.318-6.131 25.852-4.087 7.534-10.119 13.468-18.096 17.801-7.978 4.284-17.802 6.426-29.472 6.426H168.91v-22.528h33.904c6.795 0 12.36-1.182 16.693-3.545 4.333-2.364 7.534-5.614 9.602-9.75 2.118-4.137 3.176-8.889 3.176-14.256 0-5.368-1.058-10.095-3.176-14.182-2.068-4.087-5.293-7.263-9.676-9.528-4.333-2.315-9.922-3.472-16.767-3.472h-25.114v128.375h-27.403z"
	);
	path.setAttribute("fill", "currentColor");
	g.appendChild(rect);
	g.appendChild(path);
	const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
	const clipPath = document.createElementNS(
		"http://www.w3.org/2000/svg",
		"clipPath"
	);
	clipPath.setAttribute("id", "clip0_1_14");
	const clipPathPath = document.createElementNS(
		"http://www.w3.org/2000/svg",
		"path"
	);
	clipPathPath.setAttribute("d", "M0 0h300v300H0z");
	clipPath.appendChild(clipPathPath);
	defs.appendChild(clipPath);
	svg.appendChild(g);
	svg.appendChild(defs);
	return svg;
}
