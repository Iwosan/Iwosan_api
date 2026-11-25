import { Controller, Get, Header, Param, StreamableFile } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { BatchIdParamDto, DrugBatchVerificationDto } from './dto/drug-batch.dto';
import { DrugBatchesService } from './drug-batches.service';

@ApiTags('drug-batches')
@Controller('batches')
export class DrugBatchesController {
  constructor(private readonly batches: DrugBatchesService) {}

  @Public()
  @Get(':batchId')
  @ApiOperation({ summary: 'Verify a drug batch: manufacturer, custody chain and recall status' })
  @ApiResponse({ status: 200, type: DrugBatchVerificationDto })
  @ApiResponse({ status: 400, description: 'batchId is not 64 hex characters' })
  @ApiResponse({ status: 404, description: 'No batch is registered with this id' })
  verify(@Param() params: BatchIdParamDto): Promise<DrugBatchVerificationDto> {
    return this.batches.verify(params.batchId);
  }

  @Public()
  @Get(':batchId/qr')
  @Header('Content-Type', 'image/png')
  @Header('Cache-Control', 'public, max-age=86400')
  @ApiOperation({ summary: 'QR code (PNG) linking to the web verification page for a batch' })
  @ApiProduces('image/png')
  @ApiResponse({ status: 200, description: 'PNG image' })
  async qr(@Param() params: BatchIdParamDto): Promise<StreamableFile> {
    return new StreamableFile(await this.batches.qrCode(params.batchId));
  }
}
