<?php

namespace App\Entity\Traits;

use App\Entity\Enum\Level;
use App\Entity\Shop\Library;
use Doctrine\ORM\Mapping as ORM;

// Types are resolved with these imports, not with the ones of the entity using the trait
trait Owned
{
    #[ORM\ManyToOne]
    private ?Library $library = null;

    #[ORM\Column]
    private ?Level $level = null;
}
