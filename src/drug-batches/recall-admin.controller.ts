import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/entities/user.entity';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { API_BEARER_AUTH_SCHEME } from '../common/constants/swagger.constants';
import { BatchIdParamDto } from './dto/drug-batch.dto';
import { RecallNotificationsService, RecallReach } from './recall-notifications.service';

@ApiTags('drug-batches')
@ApiBearerAuth(API_BEARER_AUTH_SCHEME)
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/recalls')
export class RecallAdminController {
  constructor(private readonly recalls: RecallNotificationsService) {}

  @Get(':batchId')
  @ApiOperation({ summary: 'How many buyers of a recalled batch have been notified' })
  @ApiResponse({ status: 200, description: 'Affected orders and notification counts' })
  reach(@Param() params: BatchIdParamDto): Promise<RecallReach> {
    return this.recalls.reach(params.batchId);
  }
}
