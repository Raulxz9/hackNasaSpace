import { CommonModule } from '@angular/common';
import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, inject, input, output } from '@angular/core';
import { MapProjectionType } from '../../core/models';
import { I18nService, MapboxService } from '../../core/services';

@Component({
  selector: 'app-map-globe',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './map-globe.component.html'
})
export class MapGlobeComponent implements AfterViewInit, OnDestroy {
  readonly i18n = inject(I18nService);
  readonly mapbox = inject(MapboxService);

  readonly projection = input.required<MapProjectionType>();
  readonly projectionChange = output<MapProjectionType>();
  readonly containerReady = output<HTMLElement>();

  @ViewChild('mapContainer', { static: true }) mapContainer!: ElementRef<HTMLElement>;

  ngAfterViewInit(): void {
    this.containerReady.emit(this.mapContainer.nativeElement);
  }

  ngOnDestroy(): void {
    this.mapbox.destroy();
  }

  zoomIn(): void {
    this.mapbox.zoomIn();
  }

  zoomOut(): void {
    this.mapbox.zoomOut();
  }

  setProjection(proj: MapProjectionType): void {
    this.mapbox.setProjection(proj);
    this.projectionChange.emit(proj);
  }

  clearArea(): void {
    this.mapbox.clearArea();
  }
}
