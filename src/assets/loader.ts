export default function Icon() {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("class", "lucide lucide-loader-circle");
	const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
	path.setAttribute("d", "M21 12a9 9 0 1 1-6.219-8.56");
	svg.appendChild(path);
	return svg;
}
