export interface IrisEnvironment {
  production: boolean;
  apiUrl: string;
  mapboxToken: string;
  mapboxStyles: {
    dark: string;
    sat: string;
    terrain: string;
  };
  defaultView: {
    center: [number, number];
    zoom: number;
  };
  spinDegPerSec: number;
  spinMaxZoom: number;
  liveRefreshMs: number;
  requestTimeoutMs: number;
}

export const environment: IrisEnvironment = {
  production: true,
  apiUrl: 'https://hacknasaspace-1.onrender.com',
  mapboxToken: 'pk.eyJ1IjoiMzUyMzExMDQzNCIsImEiOiJjbXdneXpybXUwNGJhMnpwdGFzbWJiODhxIn0.7lbpDTZa6dPpYccvQGv1ZA',
  mapboxStyles: {
    dark: 'mapbox://styles/mapbox/dark-v11',
    sat: 'mapbox://styles/mapbox/satellite-streets-v12',
    terrain: 'mapbox://styles/mapbox/outdoors-v12'
  },
  defaultView: {
    center: [-100, 20],
    zoom: 1.7
  },
  spinDegPerSec: 1.5,
  spinMaxZoom: 3.2,
  liveRefreshMs: 60000,
  requestTimeoutMs: 65000
};
